/**
 * Netlify Function: getUserOrders.js
 *
 * Fetches all orders belonging to an authenticated user.
 * The caller must pass a valid Firebase ID token in the Authorization header.
 * The token is verified server-side — no client can spoof another user's orders.
 *
 * Queries across all three user-identifier fields:
 *   buyerEmail == user.email
 *   uid        == user.uid
 *   userId     == user.uid
 *
 * Results are deduplicated, sorted newest-first, and stripped of sensitive fields.
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

// Fields we never return to the client
const STRIP_FIELDS = [
    'buyerPhone',
    'stripePaymentLinkId',
    'stripeSessionId',
    'stripeCustomerId',
    'stripeCustomerEmail',
    'taxCalculationId',
    'addressComponents',
    'paymentData',
    'taxDetails',
    'notificationPreferences',
    'whatsappConsent',
    'smsConsent',
];

const HEADERS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': process.env.URL || 'https://autoinx.com',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

exports.handler = async function(event) {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: HEADERS, body: '' };
    }
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    // ── Verify Firebase ID token from Authorization header ────────────────────
    const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
    const idToken    = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!idToken) {
        return {
            statusCode: 401,
            headers: HEADERS,
            body: JSON.stringify({ error: 'Missing Authorization header' }),
        };
    }

    let decodedToken;
    try {
        decodedToken = await admin.auth().verifyIdToken(idToken);
    } catch (err) {
        return {
            statusCode: 401,
            headers: HEADERS,
            body: JSON.stringify({ error: 'Invalid or expired token. Please sign in again.' }),
        };
    }

    const uid   = decodedToken.uid;
    const email = (decodedToken.email || '').toLowerCase();

    if (!uid) {
        return {
            statusCode: 400,
            headers: HEADERS,
            body: JSON.stringify({ error: 'Token has no uid' }),
        };
    }

    try {
        const db         = getDb();
        const ordersPath = 'artifacts/default-app-id/public/data/orders';
        const colRef     = db.collection(ordersPath);

        // Fire all queries in parallel — same strategy as the storefront
        const queries = [
            colRef.where('buyerEmail', '==', email).get(),
            colRef.where('uid',        '==', uid).get(),
            colRef.where('userId',     '==', uid).get(),
        ];

        // Also query the bare 'email' field in case some orders were created that way
        if (email) {
            queries.push(colRef.where('email', '==', email).get());
        }

        const snapshots = await Promise.all(queries);

        // Deduplicate
        const seen  = new Set();
        const docs  = [];
        for (const snap of snapshots) {
            for (const docSnap of snap.docs) {
                if (!seen.has(docSnap.id)) {
                    seen.add(docSnap.id);
                    docs.push({ id: docSnap.id, ...docSnap.data() });
                }
            }
        }

        // Sort newest first
        docs.sort((a, b) => {
            const ta = a.createdAt?._seconds || (a.timestamp ? a.timestamp / 1000 : 0);
            const tb = b.createdAt?._seconds || (b.timestamp ? b.timestamp / 1000 : 0);
            return tb - ta;
        });

        // Strip sensitive fields and convert Firestore timestamps to ISO strings
        const safeOrders = docs.map(order => {
            const safe = { ...order };
            STRIP_FIELDS.forEach(f => delete safe[f]);

            // Convert Firestore Timestamp objects to ISO strings
            if (safe.createdAt?._seconds) {
                safe.createdAt = new Date(safe.createdAt._seconds * 1000).toISOString();
            }
            if (safe.updatedAt?._seconds) {
                safe.updatedAt = new Date(safe.updatedAt._seconds * 1000).toISOString();
            }

            // Only include stripePaymentUrl if order is still unpaid
            const isPaid = order.isPaid === true ||
                (typeof order.paymentStatus === 'string' &&
                 order.paymentStatus.toLowerCase() === 'paid');
            if (isPaid) delete safe.stripePaymentUrl;

            return safe;
        });

        return {
            statusCode: 200,
            headers: HEADERS,
            body: JSON.stringify({ success: true, orders: safeOrders }),
        };

    } catch (err) {
        console.error('getUserOrders error:', err);
        return {
            statusCode: 500,
            headers: HEADERS,
            body: JSON.stringify({ error: 'Failed to fetch orders. Please try again.' }),
        };
    }
};
