/**
 * reconcileMercuryPayment.js
 * Marks an order as paid and links it to a Mercury transaction.
 * Requires a valid Firebase ID token with admin custom claim.
 */

const admin = require('firebase-admin');

const ORDERS_COLLECTION = process.env.ORDERS_COLLECTION_PATH || 'artifacts/default-app-id/public/data/orders';

function initAdmin() {
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
    'Content-Type':                 'application/json',
    'Access-Control-Allow-Origin':  process.env.URL || 'https://autoinx.com',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: '' };
    if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };

    // ── Verify admin token ────────────────────────────────────────────────────
    const db         = initAdmin();
    const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
    const idToken    = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!idToken) return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: 'Missing Authorization header' }) };

    let decoded;
    try {
        decoded = await admin.auth().verifyIdToken(idToken);
    } catch {
        return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: 'Invalid or expired token' }) };
    }

    if (!decoded.admin) {
        return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ error: 'Admin access required' }) };
    }

    // ── Parse payload ─────────────────────────────────────────────────────────
    let body;
    try {
        body = JSON.parse(event.body);
    } catch {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }

    const { orderId, mercuryTransactionId, counterpartyName, amount } = body;

    if (!orderId || !mercuryTransactionId) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'orderId and mercuryTransactionId are required' }) };
    }

    // ── Update order in Firestore ─────────────────────────────────────────────
    try {
        const orderRef = db.collection(ORDERS_COLLECTION).doc(orderId);
        const orderDoc = await orderRef.get();

        if (!orderDoc.exists) {
            return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Order not found' }) };
        }

        const note = [
            `Payment reconciled via Mercury — TX: ${mercuryTransactionId}`,
            counterpartyName ? `Sender: ${counterpartyName}` : null,
            amount           ? `Amount: $${Number(amount).toFixed(2)}` : null,
            `By: ${decoded.email || decoded.uid}`,
        ].filter(Boolean).join(' | ');

        await orderRef.update({
            paymentStatus:        'Paid',
            isPaid:               true,
            mercuryTransactionId,
            mercuryReconciledAt:  admin.firestore.FieldValue.serverTimestamp(),
            mercuryReconciledBy:  decoded.email || decoded.uid,
            adminNotes:           admin.firestore.FieldValue.arrayUnion(note),
            updatedAt:            admin.firestore.FieldValue.serverTimestamp(),
        });

        console.log(`✅ Order ${orderId} reconciled with Mercury tx ${mercuryTransactionId} by ${decoded.email || decoded.uid}`);

        return {
            statusCode: 200,
            headers:    HEADERS,
            body: JSON.stringify({ success: true }),
        };
    } catch (err) {
        console.error('❌ Reconcile error:', err);
        return {
            statusCode: 500,
            headers:    HEADERS,
            body: JSON.stringify({ error: 'Failed to reconcile payment', detail: err.message }),
        };
    }
};
