const axios = require('axios');

// ─── Google Auth (Service Account → Access Token) ─────────────────────────────
// Replaces firebase-admin entirely — uses Firestore REST API instead

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function getGoogleAccessToken() {
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;

  const now = Math.floor(Date.now() / 1000);
  const header  = base64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = base64url(Buffer.from(JSON.stringify({
    iss: clientEmail,
    sub: clientEmail,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase'
  })));

  const crypto = require('crypto');
  const sign   = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const signature = base64url(sign.sign(privateKey));
  const jwt = `${header}.${payload}.${signature}`;

  const res = await axios.post('https://oauth2.googleapis.com/token', {
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion:  jwt
  }, { validateStatus: () => true });

  if (res.status !== 200) throw new Error(`Google auth failed: ${JSON.stringify(res.data)}`);
  return res.data.access_token;
}

// ─── Firestore REST helpers ────────────────────────────────────────────────────

const PROJECT = process.env.FIREBASE_PROJECT_ID;
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

function toFirestoreValue(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number')  return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  if (typeof val === 'string')  return { stringValue: val };
  if (val instanceof Date)      return { timestampValue: val.toISOString() };
  if (Array.isArray(val))       return { arrayValue: { values: val.map(toFirestoreValue) } };
  if (typeof val === 'object')  return { mapValue: { fields: toFirestoreFields(val) } };
  return { stringValue: String(val) };
}

function toFirestoreFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) fields[k] = toFirestoreValue(v);
  }
  return fields;
}

function fromFirestoreValue(v) {
  if (!v) return null;
  if ('nullValue'      in v) return null;
  if ('booleanValue'   in v) return v.booleanValue;
  if ('integerValue'   in v) return Number(v.integerValue);
  if ('doubleValue'    in v) return v.doubleValue;
  if ('stringValue'    in v) return v.stringValue;
  if ('timestampValue' in v) return new Date(v.timestampValue);
  if ('arrayValue'     in v) return (v.arrayValue.values || []).map(fromFirestoreValue);
  if ('mapValue'       in v) return fromFirestoreDoc(v.mapValue.fields || {});
  return null;
}

function fromFirestoreDoc(fields) {
  const obj = {};
  for (const [k, v] of Object.entries(fields || {})) obj[k] = fromFirestoreValue(v);
  return obj;
}

async function fsGet(token, path) {
  const res = await axios.get(`${FS_BASE}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    validateStatus: () => true
  });
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`Firestore GET failed (${res.status}): ${JSON.stringify(res.data)}`);
  return fromFirestoreDoc(res.data.fields || {});
}

async function fsSet(token, path, data, merge = false) {
  const fields = toFirestoreFields(data);
  const url    = `${FS_BASE}/${path}`;

  // Firestore REST requires repeated params: ?updateMask.fieldPaths=a&updateMask.fieldPaths=b
  // axios params object can't do this — build the query string manually
  let fullUrl = url;
  if (merge) {
    const qs = Object.keys(fields)
      .map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
      .join('&');
    fullUrl = `${url}?${qs}`;
  }

  const res = await axios.patch(fullUrl, { fields }, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    validateStatus: () => true
  });
  if (res.status !== 200) throw new Error(`Firestore SET failed (${res.status}) at ${path}: ${JSON.stringify(res.data)}`);
  return res.data;
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

  if (res.status !== 200) throw new Error(`eBay token refresh failed (${res.status}): ${JSON.stringify(res.data)}`);
  return res.data.access_token;
}

// ─── eBay Orders API ──────────────────────────────────────────────────────────

async function fetchEbayOrders(accessToken, createdAfter) {
  const res = await axios.get('https://api.ebay.com/sell/fulfillment/v1/order', {
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
  });

  if (res.status !== 200) throw new Error(`eBay orders fetch failed (${res.status}): ${JSON.stringify(res.data)}`);
  return res.data.orders || [];
}

// ─── eBay Finances API ────────────────────────────────────────────────────────
// Returns { transactionFee, shippingLabelCost } for a given eBay orderId.
// The Finances API breaks down what eBay actually charged: platform fees + label costs.

async function fetchEbayOrderFinances(accessToken, orderId) {
  try {
    const url    = 'https://api.ebay.com/sell/finances/v1/transaction';
    const filter = `orderId:{${orderId}}`;

    console.log(`  📊 Finances API call: ${url}?filter=${filter}`);

    const res = await axios.get(url, {
      params: { filter, limit: '20' },
      headers: {
        'Authorization':           `Bearer ${accessToken}`,
        'Content-Type':            'application/json',
        'X-EBAY-C-MARKETPLACE-ID': process.env.EBAY_MARKETPLACE_ID || 'EBAY_US'
      },
      validateStatus: () => true
    });

    console.log(`  📊 Finances API status: ${res.status}`);

    if (res.status !== 200) {
      console.warn(`  ⚠️  Finances API ${res.status} for order ${orderId}:`, JSON.stringify(res.data).substring(0, 300));
      return { transactionFee: 0, shippingLabelCost: 0, _status: `http_${res.status}`, _error: JSON.stringify(res.data).substring(0, 200) };
    }

    const transactions = res.data.transactions || [];
    console.log(`  📊 Finances transactions found: ${transactions.length}`);
    if (transactions.length > 0) {
      console.log(`  📊 Transaction types: ${transactions.map(t => t.transactionType).join(', ')}`);
      console.log(`  📊 First tx sample:`, JSON.stringify(transactions[0]).substring(0, 400));
    } else {
      console.log(`  ⚠️  No transactions returned — full response:`, JSON.stringify(res.data).substring(0, 500));
    }

    let transactionFee    = 0;
    let shippingLabelCost = 0;

    for (const tx of transactions) {
      const amount = Math.abs(parseFloat(tx.amount?.value || 0));
      const type   = (tx.transactionType || '').toUpperCase();

      if (type === 'SALE') {
        const items = tx.orderLineItems || [];
        for (const item of items) {
          for (const fee of item.marketplaceFees || []) {
            const feeAmt = Math.abs(parseFloat(fee.amount?.value || 0));
            console.log(`    💸 Fee: ${fee.feeType} = $${feeAmt}`);
            transactionFee += feeAmt;
          }
        }
        // Also check top-level totalFeeAmount if marketplaceFees is missing
        if (transactionFee === 0 && tx.totalFeeAmount?.value) {
          transactionFee = Math.abs(parseFloat(tx.totalFeeAmount.value));
          console.log(`    💸 Top-level totalFeeAmount: $${transactionFee}`);
        }
      }

      if (type === 'SHIPPING_LABEL') {
        shippingLabelCost += amount;
        console.log(`    🏷️  Shipping label: $${amount}`);
      }
    }

    const result = {
      transactionFee:    Math.round(transactionFee    * 100) / 100,
      shippingLabelCost: Math.round(shippingLabelCost * 100) / 100,
      _status:           'ok',
      _txCount:          transactions.length,
      _txTypes:          transactions.map(t => t.transactionType).join(','),
    };
    console.log(`  ✅ Finances result for ${orderId}:`, result);
    return result;

  } catch (err) {
    console.warn(`  ⚠️  Finances API exception for order ${orderId}:`, err.message);
    return { transactionFee: 0, shippingLabelCost: 0, _status: 'exception', _error: err.message };
  }
}

// ─── Status + order mapping ───────────────────────────────────────────────────

function mapEbayStatus(s) {
  return { PAID: 'Processing', IN_PROCESS: 'Processing', PICKUP_AVAILABLE: 'Processing', FULFILLED: 'Delivered', CANCELLED: 'Cancelled' }[s] || 'Pending';
}

function mapEbayOrder(o) {
  const line  = o.lineItems?.[0] || {};
  const buyer = o.buyer || {};
  const step  = o.fulfillmentStartInstructions?.[0]?.shippingStep || {};
  const ship  = step.shipTo || {};
  const addr  = ship.contactAddress || {};
  const price = o.pricingSummary || {};

  // Tracking: eBay puts it in different places depending on fulfillment state
  // 1. fulfillments[].shipmentTrackingNumber  — after label is purchased/shipped
  // 2. fulfillmentStartInstructions[0].shippingStep.shipmentTrackingNumber — pre-ship
  const trackingFromFulfillments = (() => {
    const fulfillments = o.fulfillments || [];
    for (const f of fulfillments) {
      // Each fulfillment may have shipmentTrackingNumber directly
      if (f.shipmentTrackingNumber) return f.shipmentTrackingNumber;
      // Or nested under trackingInfo
      if (f.trackingNumber) return f.trackingNumber;
      // Or in lineItems[].lineItemFulfillmentStatus (rare)
    }
    return null;
  })();
  const trackingFromStep = step.shipmentTrackingNumber || null;
  const trackingNumber   = trackingFromFulfillments || trackingFromStep || null;

  // Shipping address
  const shippingAddress = [addr.addressLine1, addr.addressLine2, addr.city, addr.stateOrProvince, addr.postalCode, addr.countryCode].filter(Boolean).join(', ');

  // Shipping cost: deliveryCost = what buyer paid. For free-ship listings this is 0.
  // shippingDiscountAmount subtracted from full rate gives buyer price — we store buyer price.
  const shippingCharged = Math.round(parseFloat(price.deliveryCost?.value || 0) * 100) / 100;

  // eBay fees: totalMarketplaceFee is the actual fee charged.
  // Fall back to fee.value or totalFeeBasisAmount (less accurate) if not present.
  const ebayFeeRaw = price.totalMarketplaceFee?.value
                  || price.fee?.value
                  || price.totalFeeBasisAmount?.value
                  || 0;
  const transactionCost = Math.round(parseFloat(ebayFeeRaw) * 100) / 100;

  return {
    platform:        'eBay',
    externalOrderId: o.orderId,
    customerName:    ship.fullName || buyer.username || 'eBay Buyer',
    orderDate:       (o.creationDate || '').split('T')[0] || new Date().toISOString().split('T')[0],
    product:         line.title || 'eBay Item',
    status:          mapEbayStatus(o.orderFulfillmentStatus || o.orderPaymentStatus),
    amount:          Math.round(parseFloat(line.lineItemCost?.value || 0) * 100) / 100,
    trackingNumber,
    notes:           [shippingAddress && `Ship to: ${shippingAddress}`, buyer.username && `eBay user: ${buyer.username}`, ship.email && `Email: ${ship.email}`].filter(Boolean).join(' | ') || null,
    pricing: {
      quantity:          line.quantity || 1,
      shippingCharged,
      transactionCost,
      vendorCostPerUnit: null
    },
    meta: {
      sku: line.sku || null, shippingAddress,
      buyerUsername: buyer.username || null, buyerEmail: ship.email || null,
      ebayOrderStatus: o.orderFulfillmentStatus, ebayPaymentStatus: o.orderPaymentStatus,
      ebayCreatedAt: o.creationDate, source: 'ebay_sync'
    }
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  // Auth check for manual HTTP POST trigger (admin panel button)
  // GET requests come from the internal cron trigger — allowed without auth
  if (event?.httpMethod === 'POST') {
    const authHeader = (event.headers?.authorization || event.headers?.Authorization || '');
    if (!authHeader.startsWith('Bearer ')) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
    }
    // Verify via Firebase Auth REST API (no firebase-admin needed)
    try {
      const token = authHeader.replace('Bearer ', '');
      const res   = await axios.post(
        `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${process.env.FIREBASE_API_KEY}`,
        { idToken: token },
        { validateStatus: () => true }
      );
      if (res.status !== 200 || !res.data.users?.[0]) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid token' }) };
      }
      // Check admin custom claim via token payload
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
      if (!payload.admin) {
        return { statusCode: 403, body: JSON.stringify({ error: 'Admin only' }) };
      }
    } catch (e) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Token verification failed' }) };
    }
  }

  try {
    console.log('🛒 ebaySyncOrders starting...');

    const googleToken = await getGoogleAccessToken();
    console.log('✅ Google auth OK');

    // force=true (POST body or query param) re-fetches all orders from last 90 days
    // to backfill finances and tracking for existing records
    const body        = event?.body ? (() => { try { return JSON.parse(event.body); } catch { return {}; } })() : {};
    const forceResync = body?.force === true || event?.queryStringParameters?.force === 'true';

    // Get last sync time
    const syncState  = await fsGet(googleToken, 'admin/ebay_sync_state');
    const lastSyncTs = syncState?.lastSyncedAt;

    let lastSync;
    if (forceResync) {
      lastSync = new Date(Date.now() - 90 * 24 * 3600000); // 90 days for force re-sync
      console.log('🔄 Force re-sync: fetching last 90 days');
    } else if (lastSyncTs instanceof Date) {
      lastSync = lastSyncTs;
    } else {
      lastSync = new Date(Date.now() - 30 * 24 * 3600000); // 30 days on first run
    }
    console.log(`📅 Fetching eBay orders since: ${lastSync.toISOString()}`);

    const ebayToken  = await getEbayAccessToken();
    console.log('✅ eBay auth OK');

    const ebayOrders = await fetchEbayOrders(ebayToken, lastSync.toISOString());
    console.log(`📦 Found ${ebayOrders.length} eBay orders`);

    let created = 0, updated = 0;
    const errors            = [];
    const financeDiagnostics = [];   // captured when force=true for debugging

    for (const o of ebayOrders) {
      try {
        const mapped = mapEbayOrder(o);
        const { pricing, meta, ...core } = mapped;

        // ── Fetch actual fees + label cost from Finances API ──────────────
        const finances = await fetchEbayOrderFinances(ebayToken, mapped.externalOrderId);
        if (forceResync) {
          financeDiagnostics.push({
            orderId: mapped.externalOrderId,
            finances,
          });
        }
        if (finances) {
          pricing.transactionCost   = finances.transactionFee;
          pricing.shippingLabelCost = finances.shippingLabelCost;
          console.log(`  💰 ${mapped.externalOrderId}: fee=$${finances.transactionFee} label=$${finances.shippingLabelCost}`);
        } else {
          console.log(`  ⚠️  ${mapped.externalOrderId}: Finances API returned no data`);
        }

        const indexData = await fsGet(googleToken, `external_orders_index/${mapped.externalOrderId}`);
        let savedId     = indexData?.internalId || null;

        if (!savedId) {
          // ── New order ────────────────────────────────────────────────────
          savedId = `ebay_${mapped.externalOrderId}`;
          await fsSet(googleToken, `external_orders/${savedId}`, {
            ...core, id: savedId,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });
          created++;
        } else {
          // ── Existing order: always update status, tracking, AND finances──
          // Never null-out trackingNumber if we already have it stored
          const existingDoc = await fsGet(googleToken, `external_orders/${savedId}`);
          const existingTracking = existingDoc?.trackingNumber || null;

          const coreUpdate = {
            status:    core.status,
            updatedAt: new Date().toISOString(),
          };
          // Only update tracking if we found one from eBay — don't overwrite
          // a manually-entered tracking with null
          if (core.trackingNumber) {
            coreUpdate.trackingNumber = core.trackingNumber;
          } else if (!existingTracking) {
            // Still null — leave as-is (don't write null over a manual entry)
            coreUpdate.trackingNumber = null;
          }

          await fsSet(googleToken, `external_orders/${savedId}`, coreUpdate, true);
          updated++;
        }

        // Always write full pricing (new and existing) so finances update on every sync
        await fsSet(googleToken, `external_order_pricing/${savedId}`, {
          ...pricing, ...meta, updatedAt: new Date().toISOString()
        }, true);

        await fsSet(googleToken, `external_orders_index/${mapped.externalOrderId}`, {
          internalId: savedId, platform: 'eBay',
          ebayOrderId: mapped.externalOrderId,
          lastSyncedAt: new Date().toISOString()
        });

      } catch (err) {
        console.error(`❌ Order ${o.orderId}:`, err.message);
        errors.push({ orderId: o.orderId, error: err.message });
      }
    }

    await fsSet(googleToken, 'admin/ebay_sync_state', {
      lastSyncedAt: new Date().toISOString(),
      lastRunAt:    new Date().toISOString(),
      lastResult:   { ordersFound: ebayOrders.length, created, updated, errors: errors.map(e => e.error) }
    }, true);

    const summary = { created, updated, errors };

    // When force re-sync, include diagnostics so the admin can see what happened
    if (forceResync) {
      summary.diagnostics = financeDiagnostics;
    }

    console.log(`✅ Done — ${created} new, ${updated} updated, ${errors.length} errors`);
    return { statusCode: 200, body: JSON.stringify(summary) };

  } catch (err) {
    console.error('❌ Fatal:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
