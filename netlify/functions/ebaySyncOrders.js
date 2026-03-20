const admin = require('firebase-admin');
const axios = require('axios');

// ─── Lazy Firebase init ───────────────────────────────────────────────────────
// Initialized on first use inside the handler so any errors appear in logs

let _db = null;
function getDb() {
  if (_db) return _db;
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n')
      })
    });
  }
  _db = admin.firestore();
  return _db;
}

// ─── eBay OAuth ───────────────────────────────────────────────────────────────

async function getEbayAccessToken() {
  const credentials = Buffer.from(
    `${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`
  ).toString('base64');

  const res = await axios.post(
    'https://api.ebay.com/identity/v1/oauth2/token',
    new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: process.env.EBAY_REFRESH_TOKEN,
      scope:         'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly https://api.ebay.com/oauth/api_scope/sell.finances'
    }).toString(),
    {
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type':  'application/x-www-form-urlencoded'
      },
      validateStatus: () => true
    }
  );

  if (res.status !== 200) {
    throw new Error(`eBay token refresh failed (${res.status}): ${JSON.stringify(res.data)}`);
  }
  return res.data.access_token;
}

// ─── eBay Orders API ──────────────────────────────────────────────────────────

async function fetchEbayOrders(accessToken, createdAfter) {
  const res = await axios.get(
    'https://api.ebay.com/sell/fulfillment/v1/order',
    {
      params: {
        filter:      `creationdate:[${createdAfter}]`,
        orderStatus: 'PAID,IN_PROCESS,PICKUP_AVAILABLE,FULFILLED,CANCELLED',
        limit:       '50'
      },
      headers: {
        'Authorization':           `Bearer ${accessToken}`,
        'Content-Type':            'application/json',
        'X-EBAY-C-MARKETPLACE-ID': process.env.EBAY_MARKETPLACE_ID || 'EBAY_US'
      },
      validateStatus: () => true
    }
  );

  if (res.status !== 200) {
    throw new Error(`eBay orders fetch failed (${res.status}): ${JSON.stringify(res.data)}`);
  }
  return res.data.orders || [];
}

// ─── Status mapping ───────────────────────────────────────────────────────────

function mapEbayStatus(s) {
  return { PAID: 'Processing', IN_PROCESS: 'Processing', PICKUP_AVAILABLE: 'Processing', FULFILLED: 'Delivered', CANCELLED: 'Cancelled' }[s] || 'Pending';
}

// ─── eBay → AutoInx mapping ───────────────────────────────────────────────────

function mapEbayOrder(o) {
  const line  = o.lineItems?.[0] || {};
  const buyer = o.buyer || {};
  const step  = o.fulfillmentStartInstructions?.[0]?.shippingStep || {};
  const ship  = step.shipTo || {};
  const addr  = ship.contactAddress || {};
  const price = o.pricingSummary || {};

  const shippingAddress = [addr.addressLine1, addr.addressLine2, addr.city, addr.stateOrProvince, addr.postalCode, addr.countryCode].filter(Boolean).join(', ');

  return {
    platform:        'eBay',
    externalOrderId: o.orderId,
    customerName:    ship.fullName || buyer.username || 'eBay Buyer',
    orderDate:       (o.creationDate || '').split('T')[0] || new Date().toISOString().split('T')[0],
    product:         line.title || 'eBay Item',
    status:          mapEbayStatus(o.orderFulfillmentStatus || o.orderPaymentStatus),
    amount:          Math.round(parseFloat(line.lineItemCost?.value || 0) * 100) / 100,
    trackingNumber:  step.shipmentTrackingNumber || null,
    notes:           [shippingAddress && `Ship to: ${shippingAddress}`, buyer.username && `eBay user: ${buyer.username}`, ship.email && `Email: ${ship.email}`].filter(Boolean).join(' | ') || null,
    pricing: {
      quantity:          line.quantity || 1,
      shippingCharged:   Math.round(parseFloat(price.deliveryCost?.value || 0) * 100) / 100,
      transactionCost:   Math.round((parseFloat(price.totalFeeBasisAmount?.value || price.fee?.value || 0) + parseFloat(price.tax?.value || 0)) * 100) / 100,
      vendorCostPerUnit: null
    },
    meta: {
      sku:               line.sku || null,
      shippingAddress,
      buyerUsername:     buyer.username || null,
      buyerEmail:        ship.email || null,
      ebayOrderStatus:   o.orderFulfillmentStatus,
      ebayPaymentStatus: o.orderPaymentStatus,
      ebayCreatedAt:     o.creationDate,
      source:            'ebay_sync'
    }
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  // Auth check for manual HTTP POST trigger
  if (event?.httpMethod === 'POST') {
    const auth = (event.headers?.authorization || event.headers?.Authorization || '');
    if (!auth.startsWith('Bearer ')) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
    }
    try {
      const decoded = await admin.auth().verifyIdToken(auth.replace('Bearer ', ''));
      if (!decoded.admin) return { statusCode: 403, body: JSON.stringify({ error: 'Admin only' }) };
    } catch (e) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Invalid token' }) };
    }
  }

  try {
    const db = getDb();
    console.log('🛒 ebaySyncOrders starting...');

    const syncRef  = db.collection('admin').doc('ebay_sync_state');
    const syncDoc  = await syncRef.get();
    const lastSync = syncDoc.exists
      ? (syncDoc.data().lastSyncedAt?.toDate?.() || new Date(Date.now() - 3600000))
      : new Date(Date.now() - 3600000);

    console.log(`📅 Fetching eBay orders since: ${lastSync.toISOString()}`);

    const accessToken = await getEbayAccessToken();
    const ebayOrders  = await fetchEbayOrders(accessToken, lastSync.toISOString());
    console.log(`📦 Found ${ebayOrders.length} eBay orders`);

    let created = 0, updated = 0;
    const errors = [];

    for (const o of ebayOrders) {
      try {
        const mapped = mapEbayOrder(o);
        const { pricing, meta, ...core } = mapped;

        const indexDoc = await db.collection('external_orders_index').doc(mapped.externalOrderId).get();
        let savedId    = indexDoc.exists ? indexDoc.data().internalId : null;

        if (!savedId) {
          savedId = `ebay_${mapped.externalOrderId}`;
          await db.collection('external_orders').doc(savedId).set({
            ...core, id: savedId,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
          created++;
        } else {
          await db.collection('external_orders').doc(savedId).set(
            { status: core.status, trackingNumber: core.trackingNumber, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
            { merge: true }
          );
          updated++;
        }

        await db.collection('external_order_pricing').doc(savedId).set(
          { ...pricing, ...meta, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
          { merge: true }
        );

        await db.collection('external_orders_index').doc(mapped.externalOrderId).set({
          internalId: savedId, platform: 'eBay', ebayOrderId: mapped.externalOrderId,
          lastSyncedAt: admin.firestore.FieldValue.serverTimestamp()
        });

      } catch (err) {
        console.error(`❌ Order ${o.orderId}:`, err.message);
        errors.push({ orderId: o.orderId, error: err.message });
      }
    }

    await syncRef.set({
      lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastRunAt:    admin.firestore.FieldValue.serverTimestamp(),
      lastResult:   { ordersFound: ebayOrders.length, created, updated, errors }
    }, { merge: true });

    console.log(`✅ Done — ${created} new, ${updated} updated, ${errors.length} errors`);
    return { statusCode: 200, body: JSON.stringify({ created, updated, errors }) };

  } catch (err) {
    console.error('❌ Fatal:', err.message);
    try {
      const db = getDb();
      await db.collection('admin').doc('ebay_sync_state').set(
        { lastRunAt: admin.firestore.FieldValue.serverTimestamp(), lastError: err.message },
        { merge: true }
      );
    } catch (_) {}
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
