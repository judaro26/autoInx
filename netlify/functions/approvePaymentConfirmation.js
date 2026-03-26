/**
 * Netlify Function: approvePaymentConfirmation.js
 * Approves or rejects a customer payment confirmation (Zelle/Cash).
 * Requires admin Firebase token — never trusts client-side writes.
 */
const admin = require('firebase-admin');

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
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': process.env.URL || 'https://autoinx.com',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const ORDERS_COLL          = 'artifacts/default-app-id/public/data/orders';
const CONFIRMATIONS_COLL   = 'payment_confirmations';

exports.handler = async function (event) {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: '' };
    if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };

    const db = initAdmin();

    // Verify admin token
    const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
    const idToken    = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!idToken) return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: 'Missing token' }) };

    let decoded;
    try {
        decoded = await admin.auth().verifyIdToken(idToken);
    } catch {
        return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: 'Invalid token' }) };
    }
    if (!decoded.admin) {
        return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ error: 'Admin access required' }) };
    }

    let payload;
    try { payload = JSON.parse(event.body); }
    catch { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

    const { confirmationId, orderId, decision } = payload;
    if (!confirmationId || !orderId || !['approved', 'rejected'].includes(decision)) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid parameters' }) };
    }

    try {
        const now = admin.firestore.FieldValue.serverTimestamp();

        // 1. Update the confirmation record
        await db.collection(CONFIRMATIONS_COLL).doc(confirmationId).update({
            status:     decision,
            reviewedAt: now,
            reviewedBy: decoded.email || 'admin',
        });

        // 2. Update the order
        const orderRef = db.doc(`${ORDERS_COLL}/${orderId}`);
        if (decision === 'approved') {
            await orderRef.update({
                isPaid:        true,
                paymentStatus: 'Paid',
                paidAt:        new Date().toISOString(),
                updatedAt:     now,
            });
            console.log(`✅ Payment approved for order ${orderId.slice(0, 8)} by ${decoded.email}`);
        } else {
            await orderRef.update({
                paymentConfirmationSubmitted: false,
                paymentStatus: 'Unpaid',
                updatedAt:     now,
            });
            console.log(`❌ Payment rejected for order ${orderId.slice(0, 8)} by ${decoded.email}`);
        }

        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true, decision }) };

    } catch (err) {
        console.error('approvePaymentConfirmation error:', err);
        return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
    }
};
