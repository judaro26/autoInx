/**
 * getExternalOrders.js
 *
 * Returns all external orders (eBay + manual) from Firestore for the admin panel.
 * Requires a valid admin Firebase ID token.
 */

const admin = require('firebase-admin');

function getDb() {
    if (admin.apps.length === 0) {
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId:   process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            }),
        });
    }
    return admin.firestore();
}

const HEADERS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

exports.handler = async function(event) {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: HEADERS, body: '' };
    }
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    // ── Verify admin token ────────────────────────────────────────────────────
    const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
    if (!authHeader.startsWith('Bearer ')) {
        return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    try {
        getDb(); // ensure app is initialized before calling admin.auth()
        const token   = authHeader.replace('Bearer ', '');
        const decoded = await admin.auth().verifyIdToken(token);
        if (!decoded.admin) {
            return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ error: 'Admin access required' }) };
        }
    } catch (err) {
        console.error('Token verification failed:', err.message);
        return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: 'Invalid token' }) };
    }

    // ── Fetch orders ──────────────────────────────────────────────────────────
    try {
        const db  = getDb();

        // Fetch orders and pricing in parallel.
        // Use allSettled so a pricing read failure doesn't kill the orders.
        // orderBy('orderDate') requires an index — fall back to unordered if it fails.
        let ordersSnap, pricingSnap;
        try {
            [ordersSnap, pricingSnap] = await Promise.all([
                db.collection('external_orders').orderBy('orderDate', 'desc').limit(500).get(),
                db.collection('external_order_pricing').limit(500).get(),
            ]);
        } catch (indexErr) {
            console.warn('⚠️ orderDate index missing — falling back to unordered query:', indexErr.message);
            [ordersSnap, pricingSnap] = await Promise.all([
                db.collection('external_orders').limit(500).get(),
                db.collection('external_order_pricing').limit(500).get(),
            ]);
        }

        // Build pricing map: doc id → pricing data
        const pricingMap = {};
        (pricingSnap?.docs || []).forEach(d => { pricingMap[d.id] = d.data(); });

        console.log(`📦 external_orders: ${ordersSnap.docs.length} docs, external_order_pricing: ${Object.keys(pricingMap).length} docs`);

        const orders = ordersSnap.docs.map(d => {
            const data    = d.data();
            const pricing = pricingMap[d.id] || {};

            // Log first order for debugging
            if (d === ordersSnap.docs[0]) {
                console.log('🔍 Sample order doc fields:', Object.keys(data));
                console.log('🔍 Sample pricing doc fields:', Object.keys(pricing));
            }

            return {
                id:              d.id,
                platform:        data.platform        || 'Manual',
                externalOrderId: data.externalOrderId || d.id,
                customerName:    data.customerName    || '',
                orderDate:       data.orderDate       || '',
                product:         data.product         || '',
                status:          data.status          || 'Pending',
                // amount: eBay stores line item cost in dollars (not cents)
                amount:          data.amount          || 0,
                // trackingNumber lives in external_orders (core doc from eBay sync)
                trackingNumber:  data.trackingNumber  || pricing.trackingNumber  || null,
                // shippingAddress lives in external_order_pricing (meta from eBay sync)
                shippingAddress: pricing.shippingAddress || data.shippingAddress || null,
                notes:           data.notes           || null,
                // Financial fields from external_order_pricing
                quantity:          pricing.quantity          ?? data.quantity          ?? 1,
                shippingCharged:   pricing.shippingCharged   ?? data.shippingCharged   ?? 0,
                transactionCost:   pricing.transactionCost   ?? data.transactionCost   ?? 0,
                shippingLabelCost: pricing.shippingLabelCost ?? data.shippingLabelCost ?? null,
                vendorCostPerUnit: pricing.vendorCostPerUnit ?? data.vendorCostPerUnit ?? null,
                productId:         pricing.productId         ?? data.productId         ?? null,
                // eBay meta
                sku:             pricing.sku           || data.sku           || null,
                buyerUsername:   pricing.buyerUsername || data.buyerUsername || null,
                buyerEmail:      pricing.buyerEmail    || data.buyerEmail    || null,
                createdAt:       data.createdAt        || null,
                updatedAt:       data.updatedAt        || null,
            };
        });

        console.log(`✅ getExternalOrders: returning ${orders.length} orders`);

        return {
            statusCode: 200,
            headers: HEADERS,
            body: JSON.stringify({ orders })
        };

    } catch (err) {
        console.error('❌ getExternalOrders error:', err);
        return {
            statusCode: 500,
            headers: HEADERS,
            body: JSON.stringify({ error: err.message })
        };
    }
};
