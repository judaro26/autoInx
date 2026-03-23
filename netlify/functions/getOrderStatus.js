/**
 * Netlify Function: getOrderStatus.js
 *
 * Server-side order lookup — verifies email server-side before returning
 * any data. Strips sensitive fields before sending to the client.
 *
 * Rate-limited to 10 lookups per IP per 15-minute window to prevent
 * enumeration attacks.
 */

const admin = require('firebase-admin');

// ── In-memory rate limiter (resets on cold start, good enough for Netlify) ───
const rateLimitMap = new Map();
const RATE_LIMIT_MAX    = 10;   // max attempts
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes in ms

function checkRateLimit(ip) {
    const now    = Date.now();
    const entry  = rateLimitMap.get(ip) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW };

    // Reset window if expired
    if (now > entry.resetAt) {
        entry.count   = 0;
        entry.resetAt = now + RATE_LIMIT_WINDOW;
    }

    entry.count++;
    rateLimitMap.set(ip, entry);

    return {
        allowed:     entry.count <= RATE_LIMIT_MAX,
        remaining:   Math.max(0, RATE_LIMIT_MAX - entry.count),
        resetAt:     entry.resetAt,
    };
}

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

// Fields we NEVER send back to an unauthenticated client
const STRIP_FIELDS = [
    'buyerPhone',
    'stripePaymentUrl',        // returned separately only if still unpaid
    'stripePaymentLinkId',
    'stripeSessionId',
    'stripeCustomerId',
    'stripeCustomerEmail',
    'taxCalculationId',
    'addressComponents',       // structured address — full address string is enough
    'userId',
    'paymentData',
    'taxDetails',
    'shippingDetails',
    'notificationPreferences',
    'whatsappConsent',
    'smsConsent',
];

const HEADERS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': process.env.URL || 'https://autoinx.com',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async function(event) {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: HEADERS, body: '' };
    }
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    // ── Rate limit by IP ──────────────────────────────────────────────────────
    const ip = event.headers['x-forwarded-for']?.split(',')[0]?.trim()
             || event.headers['client-ip']
             || 'unknown';

    const limit = checkRateLimit(ip);
    if (!limit.allowed) {
        const resetMins = Math.ceil((limit.resetAt - Date.now()) / 60000);
        return {
            statusCode: 429,
            headers: HEADERS,
            body: JSON.stringify({
                error: `Too many lookup attempts. Please try again in ${resetMins} minute${resetMins !== 1 ? 's' : ''}.`
            })
        };
    }

    // ── Parse & validate input ────────────────────────────────────────────────
    let orderId, email;
    try {
        const body = JSON.parse(event.body);
        orderId = (body.orderId || '').trim().toLowerCase();
        email   = (body.email   || '').trim().toLowerCase();
    } catch {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid request body' }) };
    }

    if (!orderId || !email) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'orderId and email are required' }) };
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid email format' }) };
    }
    // Firestore IDs are 20 chars; we also accept 8-char prefixes shown in emails
    if (orderId.length < 8 || orderId.length > 20) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid order ID format' }) };
    }

    try {
        const db = getDb();
        let orderData = null;
        let resolvedId = null;

        // 1. Try exact document ID
        const exactRef  = db.doc(`artifacts/default-app-id/public/data/orders/${orderId}`);
        const exactSnap = await exactRef.get();

        if (exactSnap.exists) {
            orderData  = exactSnap.data();
            resolvedId = exactSnap.id;
        } else if (orderId.length === 8) {
            // 2. Fallback: query by email, then match 8-char prefix
            //    We query by email first to limit the scan scope
            const snap = await db
                .collection('artifacts/default-app-id/public/data/orders')
                .where('buyerEmail', '==', email)
                .limit(10)
                .get();

            const match = snap.docs.find(d => d.id.startsWith(orderId));
            if (match) {
                orderData  = match.data();
                resolvedId = match.id;
            }
        }

        // ── Intentionally vague error — don't reveal whether ID exists ────────
        if (!orderData) {
            // Consistent timing to prevent timing attacks
            await new Promise(r => setTimeout(r, 200 + Math.random() * 100));
            return {
                statusCode: 404,
                headers: HEADERS,
                body: JSON.stringify({ error: 'No order found with that number and email combination.' })
            };
        }

        // ── Server-side email verification ────────────────────────────────────
        const storedEmail = (orderData.buyerEmail || '').trim().toLowerCase();
        if (storedEmail !== email) {
            // Same generic error — don't confirm the ID exists
            await new Promise(r => setTimeout(r, 200 + Math.random() * 100));
            return {
                statusCode: 404,
                headers: HEADERS,
                body: JSON.stringify({ error: 'No order found with that number and email combination.' })
            };
        }

        // ── Strip sensitive fields ────────────────────────────────────────────
        const safe = { ...orderData };
        STRIP_FIELDS.forEach(f => delete safe[f]);

        // Only include Stripe payment URL if order is still unpaid
        // (so the customer can complete payment — but only they can see it)
        const isPaid = orderData.paymentStatus === 'Paid' || orderData.isPaid;
        if (!isPaid && orderData.stripePaymentUrl) {
            safe.stripePaymentUrl = orderData.stripePaymentUrl;
        }

        // Mask phone number (show last 4 digits only) if present
        if (orderData.buyerPhone) {
            const phone = String(orderData.buyerPhone);
            safe.buyerPhoneMasked = '••••' + phone.slice(-4);
        }

        return {
            statusCode: 200,
            headers: HEADERS,
            body: JSON.stringify({
                success: true,
                order: { id: resolvedId, ...safe }
            })
        };

    } catch (err) {
        console.error('❌ getOrderStatus error:', err);
        return {
            statusCode: 500,
            headers: HEADERS,
            body: JSON.stringify({ error: 'Lookup failed. Please try again.' })
        };
    }
};
