const admin = require('firebase-admin');

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

// ─── eBay OAuth ──────────────────────────────────────────────────────────────

async function getEbayAccessToken() {
  const credentials = Buffer.from(
    `${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`
  ).toString('base64');

  const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: process.env.EBAY_REFRESH_TOKEN,
      scope: [
        'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
        'https://api.ebay.com/oauth/api_scope/sell.finances.readonly'
      ].join(' ')
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`eBay token refresh failed: ${err}`);
  }
  const data = await res.json();
  return data.access_token;
}

// ─── eBay Orders API ─────────────────────────────────────────────────────────

async function fetchEbayOrders(accessToken, createdAfter) {
  const params = new URLSearchParams({
    filter:       `creationdate:[${createdAfter}]`,
    orderStatus:  'PAID,IN_PROCESS,PICKUP_AVAILABLE,FULFILLED,CANCELLED',
    limit:        '50'
  });

  const res = await fetch(
    `https://api.ebay.com/sell/fulfillment/v1/order?${params}`,
    {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type':  'application/json',
        'X-EBAY-C-MARKETPLACE-ID': process.env.EBAY_MARKETPLACE_ID || 'EBAY_US'
      }
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`eBay orders fetch failed (${res.status}): ${err}`);
  }

  const data = await res.json();
  return data.orders || [];
}

// ─── eBay → AutoInx order mapping ────────────────────────────────────────────

function mapEbayStatus(ebayStatus) {
  const map = {
    'PAID':                'Processing',
    'IN_PROCESS':          'Processing',
    'PICKUP_AVAILABLE':    'Processing',
    'FULFILLED':           'Delivered',
    'CANCELLED':           'Cancelled'
  };
  return map[ebayStatus] || 'Pending';
}

function mapEbayOrder(ebayOrder) {
  const lineItem       = ebayOrder.lineItems?.[0] || {};
  const buyer          = ebayOrder.buyer || {};
  const shippingAddr   = ebayOrder.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo || {};
  const pricingSummary = ebayOrder.pricingSummary || {};
  const fulfillments   = ebayOrder.fulfillmentHrefs || [];

  // Build full customer name
  const customerName = shippingAddr.fullName ||
    `${buyer.buyerRegistrationAddress?.fullName || buyer.username || 'eBay Buyer'}`;

  // Build full shipping address string
  const addr = shippingAddr.contactAddress || {};
  const shippingAddress = [
    addr.addressLine1,
    addr.addressLine2,
    addr.city,
    addr.stateOrProvince,
    addr.postalCode,
    addr.countryCode
  ].filter(Boolean).join(', ');

  // Financial fields
  const salePriceCents      = parseFloat(lineItem.lineItemCost?.value || 0) * 100;
  const shippingCostCents   = parseFloat(pricingSummary.deliveryCost?.value || 0) * 100;
  const totalFeeCents       = parseFloat(pricingSummary.totalFeeBasisAmount?.value ||
                              pricingSummary.fee?.value || 0) * 100;
  const taxCents            = parseFloat(pricingSummary.tax?.value || 0) * 100;
  const totalCents          = parseFloat(ebayOrder.pricingSummary?.total?.value || 0) * 100;
  const qty                 = lineItem.quantity || 1;

  // Product info
  const productTitle = lineItem.title || 'eBay Item';
  const sku          = lineItem.sku   || lineItem.legacyItemId || '';

  // Tracking
  const trackingNumber = ebayOrder.fulfillmentStartInstructions?.[0]
    ?.shippingStep?.shipmentTrackingNumber || null;

  // Order date — normalise to YYYY-MM-DD
  const orderDate = ebayOrder.creationDate
    ? ebayOrder.creationDate.split('T')[0]
    : new Date().toISOString().split('T')[0];

  return {
    // Core fields (written via saveExternalOrder Netlify function)
    platform:        'eBay',
    externalOrderId: ebayOrder.orderId,
    customerName,
    orderDate,
    product:         productTitle,
    status:          mapEbayStatus(ebayOrder.orderFulfillmentStatus || ebayOrder.orderPaymentStatus),
    amount:          salePriceCents / 100,       // dollars
    trackingNumber,
    notes: [
      shippingAddress   ? `Ship to: ${shippingAddress}`     : null,
      buyer.username    ? `eBay user: ${buyer.username}`    : null,
      shippingAddr.email? `Email: ${shippingAddr.email}`    : null,
    ].filter(Boolean).join(' | ') || null,

    // Financial extras (written to external_order_pricing Firestore collection)
    pricing: {
      quantity:          qty,
      shippingCharged:   shippingCostCents  / 100,
      transactionCost:   (totalFeeCents + taxCents) / 100,
      vendorCostPerUnit: null,   // will be filled when synced with vendor order
    },

    // Rich metadata stored in external_order_pricing for reference
    meta: {
      sku,
      shippingAddress,
      buyerUsername:     buyer.username || null,
      buyerEmail:        shippingAddr.email || null,
      buyerPhone:        shippingAddr.primaryPhone?.phoneNumber || null,
      totalCents:        Math.round(totalCents),
      shippingCents:     Math.round(shippingCostCents),
      taxCents:          Math.round(taxCents),
      feeCents:          Math.round(totalFeeCents),
      ebayOrderStatus:   ebayOrder.orderFulfillmentStatus,
      ebayPaymentStatus: ebayOrder.orderPaymentStatus,
      ebayCreatedAt:     ebayOrder.creationDate,
      ebayUpdatedAt:     ebayOrder.lastModifiedDate,
      fulfillmentHrefs:  fulfillments,
      source:            'ebay_sync',
    }
  };
}

// ─── Persist to Firestore + Netlify saveExternalOrder ────────────────────────

async function upsertOrder(mapped, syncRef) {
  const { pricing, meta, ...coreFields } = mapped;

  // Check if this eBay order already exists in Firestore by externalOrderId
  const existing = await db
    .collection('external_orders_index')
    .doc(mapped.externalOrderId)
    .get();

  let savedId = existing.exists ? existing.data().internalId : null;

  if (!savedId) {
    // New order — call the existing saveExternalOrder Netlify function
    // so it goes through the same pipeline as manually created orders
    const netlifyUrl = process.env.URL || 'https://autoinx.com';
    const res = await fetch(`${netlifyUrl}/.netlify/functions/saveExternalOrder`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${process.env.EBAY_SYNC_SERVICE_TOKEN || ''}`
      },
      body: JSON.stringify({ ...coreFields, _source: 'ebay_sync' })
    });

    if (res.ok) {
      const data = await res.json();
      savedId = data.id || data.orderId;
    }
  }

  if (!savedId) {
    // Fallback: write directly to external_order_pricing with all data
    savedId = `ebay_${mapped.externalOrderId}`;
  }

  // Write pricing + rich metadata to Firestore
  await db.collection('external_order_pricing').doc(savedId).set({
    ...pricing,
    ...meta,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  // Write index so we can look up by eBay order ID next time
  await db.collection('external_orders_index').doc(mapped.externalOrderId).set({
    internalId:    savedId,
    platform:      'eBay',
    ebayOrderId:   mapped.externalOrderId,
    lastSyncedAt:  admin.firestore.FieldValue.serverTimestamp()
  });

  return savedId;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

const handler = async (event) => {
  // When triggered via HTTP (manual sync button), verify admin Firebase token.
  // Scheduled invocations from Netlify have no httpMethod — skip auth for those.
  if (event?.httpMethod === 'POST') {
    const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
    }
    try {
      const idToken     = authHeader.split('Bearer ')[1];
      const decoded     = await admin.auth().verifyIdToken(idToken);
      if (!decoded.admin) {
        return { statusCode: 403, body: JSON.stringify({ error: 'Admin access required' }) };
      }
    } catch (e) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Invalid token' }) };
    }
  }

  try {
    console.log('🛒 ebaySyncOrders starting...');

    // Get last sync time from Firestore (default: 1 hour ago for first run)
    const syncRef  = db.collection('admin').doc('ebay_sync_state');
    const syncDoc  = await syncRef.get();
    const lastSync = syncDoc.exists
      ? syncDoc.data().lastSyncedAt?.toDate?.() || new Date(Date.now() - 3600000)
      : new Date(Date.now() - 3600000);

    // Format as eBay expects: 2024-01-15T00:00:00.000Z
    const createdAfter = lastSync.toISOString();
    console.log(`📅 Fetching eBay orders since: ${createdAfter}`);

    const accessToken = await getEbayAccessToken();
    const ebayOrders  = await fetchEbayOrders(accessToken, createdAfter);
    console.log(`📦 Found ${ebayOrders.length} eBay orders`);

    let created = 0;
    let updated = 0;
    const errors = [];

    for (const ebayOrder of ebayOrders) {
      try {
        const mapped     = mapEbayOrder(ebayOrder);
        const isExisting = (await db
          .collection('external_orders_index')
          .doc(ebayOrder.orderId)
          .get()).exists;

        await upsertOrder(mapped, syncRef);
        isExisting ? updated++ : created++;
      } catch (err) {
        console.error(`❌ Failed to sync order ${ebayOrder.orderId}:`, err.message);
        errors.push({ orderId: ebayOrder.orderId, error: err.message });
      }
    }

    // Save sync state
    await syncRef.set({
      lastSyncedAt:  admin.firestore.FieldValue.serverTimestamp(),
      lastRunAt:     admin.firestore.FieldValue.serverTimestamp(),
      lastResult: {
        ordersFound: ebayOrders.length,
        created,
        updated,
        errors
      }
    }, { merge: true });

    console.log(`✅ eBay sync complete — ${created} new, ${updated} updated, ${errors.length} errors`);
    return { statusCode: 200 };

  } catch (err) {
    console.error('❌ ebaySyncOrders fatal error:', err);

    // Save error state so admin can see it
    await db.collection('admin').doc('ebay_sync_state').set({
      lastRunAt:    admin.firestore.FieldValue.serverTimestamp(),
      lastError:    err.message,
    }, { merge: true }).catch(() => {});

    return { statusCode: 500 };
  }
};

exports.handler = handler;
