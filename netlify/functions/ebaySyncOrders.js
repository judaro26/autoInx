const admin  = require('firebase-admin');
const https  = require('https');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    })
  });
}

const db = admin.firestore();

// ─── Node-native HTTP helper (no fetch dependency) ────────────────────────────

function httpRequest(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const reqOptions = {
      hostname: urlObj.hostname,
      path:     urlObj.pathname + urlObj.search,
      method:   options.method || 'GET',
      headers:  options.headers || {}
    };
    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: () => data, json: () => JSON.parse(data) });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ─── eBay OAuth ───────────────────────────────────────────────────────────────

async function getEbayAccessToken() {
  const credentials = Buffer.from(
    `${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`
  ).toString('base64');

  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: process.env.EBAY_REFRESH_TOKEN,
    scope:         'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly https://api.ebay.com/oauth/api_scope/sell.finances'
  }).toString();

  const res = await httpRequest(
    'https://api.ebay.com/identity/v1/oauth2/token',
    {
      method: 'POST',
      headers: {
        'Authorization':  `Basic ${credentials}`,
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    },
    body
  );

  if (!res.ok) throw new Error(`eBay token refresh failed: ${res.text()}`);
  return res.json().access_token;
}

// ─── eBay Orders API ──────────────────────────────────────────────────────────

async function fetchEbayOrders(accessToken, createdAfter) {
  const params = new URLSearchParams({
    filter:      `creationdate:[${createdAfter}]`,
    orderStatus: 'PAID,IN_PROCESS,PICKUP_AVAILABLE,FULFILLED,CANCELLED',
    limit:       '50'
  });

  const res = await httpRequest(
    `https://api.ebay.com/sell/fulfillment/v1/order?${params}`,
    {
      method: 'GET',
      headers: {
        'Authorization':             `Bearer ${accessToken}`,
        'Content-Type':              'application/json',
        'X-EBAY-C-MARKETPLACE-ID':   process.env.EBAY_MARKETPLACE_ID || 'EBAY_US'
      }
    }
  );

  if (!res.ok) throw new Error(`eBay orders fetch failed (${res.status}): ${res.text()}`);
  return res.json().orders || [];
}

// ─── Status mapping ───────────────────────────────────────────────────────────

function mapEbayStatus(ebayStatus) {
  const map = {
    PAID:               'Processing',
    IN_PROCESS:         'Processing',
    PICKUP_AVAILABLE:   'Processing',
    FULFILLED:          'Delivered',
    CANCELLED:          'Cancelled'
  };
  return map[ebayStatus] || 'Pending';
}

// ─── eBay → AutoInx order mapping ────────────────────────────────────────────

function mapEbayOrder(ebayOrder) {
  const lineItem       = ebayOrder.lineItems?.[0] || {};
  const buyer          = ebayOrder.buyer || {};
  const shippingStep   = ebayOrder.fulfillmentStartInstructions?.[0]?.shippingStep || {};
  const shippingAddr   = shippingStep.shipTo || {};
  const addr           = shippingAddr.contactAddress || {};
  const pricingSummary = ebayOrder.pricingSummary || {};

  const customerName = shippingAddr.fullName ||
    buyer.buyerRegistrationAddress?.fullName ||
    buyer.username || 'eBay Buyer';

  const shippingAddress = [
    addr.addressLine1, addr.addressLine2,
    addr.city, addr.stateOrProvince,
    addr.postalCode, addr.countryCode
  ].filter(Boolean).join(', ');

  const salePriceCents    = Math.round(parseFloat(lineItem.lineItemCost?.value || 0) * 100);
  const shippingCostCents = Math.round(parseFloat(pricingSummary.deliveryCost?.value || 0) * 100);
  const feeCents          = Math.round(parseFloat(pricingSummary.totalFeeBasisAmount?.value || pricingSummary.fee?.value || 0) * 100);
  const taxCents          = Math.round(parseFloat(pricingSummary.tax?.value || 0) * 100);
  const qty               = lineItem.quantity || 1;

  const trackingNumber = shippingStep.shipmentTrackingNumber || null;
  const orderDate = ebayOrder.creationDate
    ? ebayOrder.creationDate.split('T')[0]
    : new Date().toISOString().split('T')[0];

  return {
    platform:        'eBay',
    externalOrderId: ebayOrder.orderId,
    customerName,
    orderDate,
    product:         lineItem.title || 'eBay Item',
    status:          mapEbayStatus(ebayOrder.orderFulfillmentStatus || ebayOrder.orderPaymentStatus),
    amount:          salePriceCents / 100,
    trackingNumber,
    notes: [
      shippingAddress         ? `Ship to: ${shippingAddress}`  : null,
      buyer.username          ? `eBay user: ${buyer.username}` : null,
      shippingAddr.email      ? `Email: ${shippingAddr.email}` : null,
    ].filter(Boolean).join(' | ') || null,

    pricing: {
      quantity:         qty,
      shippingCharged:  shippingCostCents / 100,
      transactionCost:  (feeCents + taxCents) / 100,
      vendorCostPerUnit: null,
    },

    meta: {
      sku:               lineItem.sku || lineItem.legacyItemId || null,
      shippingAddress,
      buyerUsername:     buyer.username || null,
      buyerEmail:        shippingAddr.email || null,
      buyerPhone:        shippingAddr.primaryPhone?.phoneNumber || null,
      totalCents:        Math.round(parseFloat(pricingSummary.total?.value || 0) * 100),
      shippingCents:     shippingCostCents,
      taxCents,
      feeCents,
      ebayOrderStatus:   ebayOrder.orderFulfillmentStatus,
      ebayPaymentStatus: ebayOrder.orderPaymentStatus,
      ebayCreatedAt:     ebayOrder.creationDate,
      ebayUpdatedAt:     ebayOrder.lastModifiedDate,
      source:            'ebay_sync',
    }
  };
}

// ─── Write to Firestore directly ──────────────────────────────────────────────

async function upsertOrder(mapped) {
  const { pricing, meta, ...coreFields } = mapped;

  // Check if already synced
  const indexDoc = await db.collection('external_orders_index').doc(mapped.externalOrderId).get();
  let savedId    = indexDoc.exists ? indexDoc.data().internalId : null;

  if (!savedId) {
    // Write core order fields to external_orders collection directly
    savedId = `ebay_${mapped.externalOrderId}`;
    await db.collection('external_orders').doc(savedId).set({
      ...coreFields,
      id:        savedId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } else {
    // Update status and tracking on existing order
    await db.collection('external_orders').doc(savedId).set({
      status:        coreFields.status,
      trackingNumber: coreFields.trackingNumber,
      updatedAt:     admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  // Write financial metadata
  await db.collection('external_order_pricing').doc(savedId).set({
    ...pricing,
    ...meta,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  // Update index
  await db.collection('external_orders_index').doc(mapped.externalOrderId).set({
    internalId:   savedId,
    platform:     'eBay',
    ebayOrderId:  mapped.externalOrderId,
    lastSyncedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  return savedId;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

const handler = async (event) => {
  // Verify Firebase admin token when triggered via HTTP POST (manual sync button)
  // Scheduled invocations from Netlify have no httpMethod — skip auth for those
  if (event?.httpMethod === 'POST') {
    const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
    }
    try {
      const decoded = await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1]);
      if (!decoded.admin) {
        return { statusCode: 403, body: JSON.stringify({ error: 'Admin access required' }) };
      }
    } catch (e) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Invalid token' }) };
    }
  }

  try {
    console.log('🛒 ebaySyncOrders starting...');

    const syncRef  = db.collection('admin').doc('ebay_sync_state');
    const syncDoc  = await syncRef.get();
    const lastSync = syncDoc.exists
      ? syncDoc.data().lastSyncedAt?.toDate?.() || new Date(Date.now() - 3600000)
      : new Date(Date.now() - 3600000);

    const createdAfter = lastSync.toISOString();
    console.log(`📅 Fetching eBay orders since: ${createdAfter}`);

    const accessToken = await getEbayAccessToken();
    const ebayOrders  = await fetchEbayOrders(accessToken, createdAfter);
    console.log(`📦 Found ${ebayOrders.length} eBay orders`);

    let created = 0, updated = 0;
    const errors = [];

    for (const ebayOrder of ebayOrders) {
      try {
        const mapped     = mapEbayOrder(ebayOrder);
        const isExisting = (await db.collection('external_orders_index').doc(ebayOrder.orderId).get()).exists;
        await upsertOrder(mapped);
        isExisting ? updated++ : created++;
      } catch (err) {
        console.error(`❌ Failed to sync order ${ebayOrder.orderId}:`, err.message);
        errors.push({ orderId: ebayOrder.orderId, error: err.message });
      }
    }

    await syncRef.set({
      lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastRunAt:    admin.firestore.FieldValue.serverTimestamp(),
      lastResult:   { ordersFound: ebayOrders.length, created, updated, errors }
    }, { merge: true });

    console.log(`✅ eBay sync complete — ${created} new, ${updated} updated, ${errors.length} errors`);
    return { statusCode: 200, body: JSON.stringify({ created, updated, errors }) };

  } catch (err) {
    console.error('❌ ebaySyncOrders fatal error:', err.message);
    await db.collection('admin').doc('ebay_sync_state').set({
      lastRunAt:  admin.firestore.FieldValue.serverTimestamp(),
      lastError:  err.message,
    }, { merge: true }).catch(() => {});
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

exports.handler = handler;
