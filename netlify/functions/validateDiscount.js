/**
 * Netlify Function: validateDiscount.js
 *
 * Public endpoint — validates a discount code and returns its details.
 * Called immediately when a customer enters a code, before they fill in
 * address or shipping details, so they know the code is valid early.
 *
 * Rate-limited per IP to prevent brute-force code guessing.
 */

const admin = require('firebase-admin');

const RATE_LIMIT = 20;               // attempts per window
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const rateLimitStore = {};

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
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async function (event) {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: '' };
    if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };

    // Rate limiting
    const ip  = event.headers['client-ip'] || event.headers['x-forwarded-for'] || 'unknown';
    const now = Date.now();
    if (!rateLimitStore[ip]) rateLimitStore[ip] = [];
    rateLimitStore[ip] = rateLimitStore[ip].filter(t => t > now - RATE_WINDOW_MS);
    if (rateLimitStore[ip].length >= RATE_LIMIT) {
        return { statusCode: 429, headers: HEADERS, body: JSON.stringify({ valid: false, error: 'Too many attempts' }) };
    }
    rateLimitStore[ip].push(now);

    let payload;
    try { payload = JSON.parse(event.body); }
    catch { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ valid: false, error: 'Invalid JSON' }) }; }

    const code          = (payload.code || '').trim().toUpperCase();
    const cartTotalCents = parseInt(payload.cartTotalCents) || 0;
    const lang          = payload.lang || 'en';

    if (!code) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ valid: false, error: 'No code provided' }) };
    }

    try {
        const db   = initAdmin();
        const snap = await db
            .collection('artifacts/default-app-id/public/data/discounts')
            .where('code', '==', code)
            .where('enabled', '==', true)
            .limit(1)
            .get();

        if (snap.empty) {
            return { statusCode: 200, headers: HEADERS, body: JSON.stringify({
                valid: false,
                error: lang === 'es' ? 'Código inválido o expirado' : 'Invalid or expired code'
            }) };
        }

        const discount = { id: snap.docs[0].id, ...snap.docs[0].data() };

        // Expiration check
        if (discount.expiresAt && new Date(discount.expiresAt) < new Date()) {
            return { statusCode: 200, headers: HEADERS, body: JSON.stringify({
                valid: false,
                error: lang === 'es' ? 'Este código ha expirado' : 'This code has expired'
            }) };
        }

        // Usage limit check
        if (discount.maxUses > 0 && (discount.currentUses || 0) >= discount.maxUses) {
            return { statusCode: 200, headers: HEADERS, body: JSON.stringify({
                valid: false,
                error: lang === 'es' ? 'Este código ya no está disponible' : 'This code is no longer available'
            }) };
        }

        // Minimum order check
        if (discount.minOrderCents > 0 && cartTotalCents > 0 && cartTotalCents < discount.minOrderCents) {
            const min = (discount.minOrderCents / 100).toFixed(2);
            return { statusCode: 200, headers: HEADERS, body: JSON.stringify({
                valid: false,
                error: lang === 'es'
                    ? `Monto mínimo de pedido: $${min}`
                    : `Minimum order amount: $${min}`
            }) };
        }

        // Build human-readable description
        let description;
        if (discount.type === 'percentage') {
            description = lang === 'es' ? `${discount.value}% de descuento` : `${discount.value}% off`;
        } else if (discount.type === 'fixed') {
            description = lang === 'es' ? `$${discount.value} de descuento` : `$${discount.value} off`;
        } else {
            description = lang === 'es' ? 'Envío gratuito' : 'Free shipping';
        }

        return {
            statusCode: 200,
            headers: HEADERS,
            body: JSON.stringify({
                valid:       true,
                code:        discount.code,
                type:        discount.type,
                value:       discount.value,
                description,
                minOrderCents:      discount.minOrderCents || 0,
                appliesToCategory:  discount.appliesToCategory || 'all',
            }),
        };

    } catch (err) {
        console.error('validateDiscount error:', err);
        return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ valid: false, error: 'Server error' }) };
    }
};
