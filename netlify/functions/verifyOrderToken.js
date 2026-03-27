/**
 * Netlify Function: verifyOrderToken.js
 *
 * Verifies a tokenized order view link so guests can see their order
 * details without re-entering their email address.
 *
 * Token is a 32-char HMAC-SHA256 hex digest of "{orderId}:{email}"
 * signed with ORDER_EMAIL_SECRET. Embedded in confirmation emails.
 *
 * Returns the order data if the token is valid.
 */

const admin  = require('firebase-admin');
const crypto = require('crypto');

const ORDERS_COLL = 'artifacts/default-app-id/public/data/orders';

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

function verifyToken(orderId, email, token) {
    const secret  = process.env.ORDER_EMAIL_SECRET || 'autoinx-email-secret';
    const payload = `${orderId}:${email.toLowerCase()}`;
    const expected = crypto
        .createHmac('sha256', secret)
        .update(payload)
        .digest('hex')
        .slice(0, 32);
    try {
        return crypto.timingSafeEqual(
            Buffer.from(expected, 'hex'),
            Buffer.from(token,    'hex')
        );
    } catch { return false; }
}

const HEADERS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin':  process.env.URL || 'https://autoinx.com',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

// Fields safe to return to a verified guest
const GUEST_SAFE_FIELDS = [
    'id', 'orderNumber', 'status', 'paymentStatus', 'paymentMethod',
    'paymentConfirmationSubmitted', 'items', 'totalCents', 'subtotalCents',
    'shippingCents', 'taxCents', 'discountCents', 'discount',
    'shippingDetails', 'deliveryAddress', 'buyerName', 'buyerEmail',
    'createdAt', 'timestamp', 'updatedAt', 'isPaid', 'paidAt',
    'stripePaymentUrl', 'trackingNumber', 'labelUrl',
];

exports.handler = async function (event) {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: '' };
    if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };

    let payload;
    try { payload = JSON.parse(event.body); }
    catch { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

    const { orderId, email, token } = payload;

    if (!orderId || !email || !token) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'orderId, email, and token are required' }) };
    }

    if (!verifyToken(orderId, email, token)) {
        return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ error: 'Invalid or expired token' }) };
    }

    try {
        const db        = initAdmin();
        const orderSnap = await db.doc(`${ORDERS_COLL}/${orderId}`).get();

        if (!orderSnap.exists) {
            return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Order not found' }) };
        }

        const data  = orderSnap.data();

        // Double-check email matches (belt and suspenders)
        const storedEmail = (data.buyerEmail || '').toLowerCase().trim();
        if (storedEmail && storedEmail !== email.toLowerCase().trim()) {
            return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ error: 'Token does not match order' }) };
        }

        // Return only guest-safe fields
        const safe = { id: orderSnap.id };
        for (const key of GUEST_SAFE_FIELDS) {
            if (data[key] !== undefined) safe[key] = data[key];
        }

        return {
            statusCode: 200,
            headers: HEADERS,
            body: JSON.stringify({ valid: true, order: safe }),
        };

    } catch (err) {
        console.error('verifyOrderToken error:', err);
        return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'Server error' }) };
    }
};
