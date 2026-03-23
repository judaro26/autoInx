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
        const db   = getDb();

        // Fetch orders and their pricing data in parallel
        const [ordersSnap, pricingSnap] = await Promise.all([
            db.collection('external_orders').orderBy('orderDate', 'desc').limit(500).get(),
            db.collection('external_order_pricing').get(),
        ]);

        // Build pricing map keyed by order id
        const pricingMap = {};
        pricingSnap.docs.forEach(d => { pricingMap[d.id] = d.data(); });

        const orders = ordersSnap.docs.map(d => {
            const data    = d.data();
            const pricing = pricingMap[d.id] || {};

            return {
                id:              d.id,
                platform:        data.platform        || 'Manual',
                externalOrderId: data.externalOrderId || d.id,
                customerName:    data.customerName    || '',
                orderDate:       data.orderDate       || '',
                product:         data.product         || '',
                status:          data.status          || 'Pending',
                amount:          data.amount          || 0,
                // Tracking — core doc first, pricing meta as fallback
                trackingNumber:  data.trackingNumber  || pricing.trackingNumber  || null,
                shippingAddress: data.shippingAddress || pricing.shippingAddress || null,
                notes:           data.notes           || null,
                // Financial fields from pricing collection
                quantity:          pricing.quantity          ?? data.quantity          ?? 1,
                shippingCharged:   pricing.shippingCharged   ?? data.shippingCharged   ?? 0,
                transactionCost:   pricing.transactionCost   ?? data.transactionCost   ?? 0,
                vendorCostPerUnit: pricing.vendorCostPerUnit ?? data.vendorCostPerUnit ?? null,
                productId:         pricing.productId         ?? data.productId         ?? null,
                // eBay meta fields
                buyerUsername:   pricing.buyerUsername  || null,
                buyerEmail:      pricing.buyerEmail     || null,
                sku:             pricing.sku            || null,
                createdAt:       data.createdAt         || null,
                updatedAt:       data.updatedAt         || null,
            };
        });

        console.log(`✅ getExternalOrders: returned ${orders.length} orders`);

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
