/**
 * Netlify Function: submitPaymentConfirmation.js
 *
 * Allows guest customers (no Firebase account) to submit payment confirmations.
 * Validates that the orderId exists and the email matches, then writes
 * to payment_confirmations collection via Admin SDK.
 *
 * Screenshot uploads go through uploadPaymentProof.js separately.
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
    'Access-Control-Allow-Origin':  process.env.URL || 'https://autoinx.com',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

const ORDERS_COLL        = 'artifacts/default-app-id/public/data/orders';
const CONFIRMATIONS_COLL = 'payment_confirmations';

exports.handler = async function (event) {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: '' };
    if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };

    const db = initAdmin();

    let payload;
    try { payload = JSON.parse(event.body); }
    catch { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

    const { orderId, method, amountPaid, screenshotUrl, notes, customerEmail, isGuest } = payload;

    if (!orderId || !method) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'orderId and method required' }) };
    }

    // Verify the order exists and the email matches (security check for guest path)
    try {
        const orderSnap = await db.doc(`${ORDERS_COLL}/${orderId}`).get();
        if (!orderSnap.exists) {
            return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Order not found' }) };
        }

        const order = orderSnap.data();

        if (isGuest && customerEmail) {
            const orderEmail = (order.buyerEmail || order.email || '').toLowerCase().trim();
            const submitted  = (customerEmail || '').toLowerCase().trim();
            if (orderEmail !== submitted) {
                return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ error: 'Email does not match order' }) };
            }
        }

        // Check for duplicate submission
        if (order.paymentConfirmationSubmitted) {
            // Allow re-submission (customer may be adding a new screenshot)
            console.log(`ℹ️ Re-submission for order ${orderId.slice(0,8)}`);
        }

        const now = admin.firestore.FieldValue.serverTimestamp();

        // Write confirmation
        await db.collection(CONFIRMATIONS_COLL).add({
            orderId,
            orderIdShort:   orderId.slice(0, 8),
            userId:         null,      // guest — no Firebase UID
            customerEmail:  customerEmail || order.buyerEmail || null,
            paymentMethod:  method,
            amountPaid:     amountPaid || null,
            screenshotUrl:  screenshotUrl || null,
            notes:          notes || null,
            status:         'pending_review',
            isGuest:        true,
            submittedAt:    now,
        });

        // Mark order
        await db.doc(`${ORDERS_COLL}/${orderId}`).update({
            paymentConfirmationSubmitted: true,
            paymentStatus: 'Confirmation Submitted',
            updatedAt:     now,
        });

        console.log(`✅ Guest payment confirmation saved for order ${orderId.slice(0,8)}`);
        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };

    } catch (err) {
        console.error('submitPaymentConfirmation error:', err);
        return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
    }
};
