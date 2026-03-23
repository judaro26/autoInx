/**
 * saveExternalOrder.js
 *
 * Creates or updates an external order (eBay / manual) in Firestore.
 * - New orders: creates doc in external_orders/{id}
 * - Existing orders: updates only changed fields (upsert)
 *
 * Requires admin Firebase ID token.
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
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

exports.handler = async function(event) {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: HEADERS, body: '' };
    }
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    // ── Verify admin token ────────────────────────────────────────────────────
    const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
    if (!authHeader.startsWith('Bearer ')) {
        return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    try {
        getDb(); // init app before admin.auth()
        const decoded = await admin.auth().verifyIdToken(authHeader.replace('Bearer ', ''));
        if (!decoded.admin) {
            return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ error: 'Admin access required' }) };
        }
    } catch (err) {
        console.error('Token verification failed:', err.message);
        return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: 'Invalid token' }) };
    }

    // ── Parse body ────────────────────────────────────────────────────────────
    let orderData;
    try {
        orderData = JSON.parse(event.body);
    } catch {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }

    const { id, platform, externalOrderId, customerName, orderDate,
            product, status, amount, trackingNumber, notes } = orderData;

    if (!platform || !customerName || !orderDate || !product) {
        return {
            statusCode: 400,
            headers: HEADERS,
            body: JSON.stringify({ error: 'Missing required fields: platform, customerName, orderDate, product' })
        };
    }

    try {
        const db  = getDb();
        const col = db.collection('external_orders');
        const now = admin.firestore.FieldValue.serverTimestamp();

        // ── Determine doc ref ─────────────────────────────────────────────────
        // Existing orders have an id already (from eBay sync: "ebay_xxx" or auto-id)
        // New manual orders get an auto-generated id
        let docRef;
        const isNew = !id;

        if (id) {
            docRef = col.doc(id);
        } else {
            docRef = col.doc(); // auto-id
        }

        const payload = {
            platform:        platform        || 'Manual',
            externalOrderId: externalOrderId || docRef.id,
            customerName:    customerName    || '',
            orderDate:       orderDate       || '',
            product:         product         || '',
            status:          status          || 'Pending',
            amount:          typeof amount === 'number' ? amount : (parseFloat(amount) || 0),
            trackingNumber:  trackingNumber  || null,
            notes:           notes           || null,
            updatedAt:       now,
        };

        if (isNew) {
            payload.createdAt = now;
            await docRef.set(payload);
            console.log(`✅ Created external order: ${docRef.id}`);
        } else {
            // set with merge so eBay-synced fields (meta, pricing) are preserved
            await docRef.set(payload, { merge: true });
            console.log(`✅ Updated external order: ${docRef.id}`);
        }

        return {
            statusCode: 200,
            headers: HEADERS,
            body: JSON.stringify({
                success: true,
                id:      docRef.id,
                orderId: docRef.id,
                isNew,
            })
        };

    } catch (err) {
        console.error('❌ saveExternalOrder error:', err);
        return {
            statusCode: 500,
            headers: HEADERS,
            body: JSON.stringify({ error: 'Failed to save order', details: err.message })
        };
    }
};
