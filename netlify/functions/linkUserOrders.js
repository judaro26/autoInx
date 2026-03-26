/**
 * Netlify Function: linkUserOrders.js
 *
 * Called after sign-in to backfill the user's uid onto any orders that were
 * placed as a guest (userId: 'guest' | 'anonymous' | missing) but share the
 * same buyerEmail as the now-authenticated user.
 *
 * This is what makes the flow work:
 *   Guest places order → registers/signs in later → sees their order
 *
 * Safe to call on every sign-in — it only patches orders that are missing
 * the uid, so it's fully idempotent.
 *
 * Auth: requires a valid Firebase ID token in the Authorization header.
 * The token is verified server-side; only orders whose buyerEmail matches
 * the verified token's email will be patched.
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
}

const HEADERS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': process.env.URL || 'https://autoinx.com',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const ORDERS_PATH = 'artifacts/default-app-id/public/data/orders';

// userId values that indicate an order was placed without an account
const GUEST_USER_IDS = new Set(['guest', 'anonymous', '', null, undefined]);

exports.handler = async function(event) {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: HEADERS, body: '' };
    }
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    // ── Verify Firebase ID token ──────────────────────────────────────────────
    initAdmin();

    const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
    const idToken    = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!idToken) {
        return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: 'Missing Authorization header' }) };
    }

    let decodedToken;
    try {
        decodedToken = await admin.auth().verifyIdToken(idToken);
    } catch (err) {
        return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: 'Invalid or expired token' }) };
    }

    const uid   = decodedToken.uid;
    const email = (decodedToken.email || '').trim().toLowerCase();

    if (!uid || !email) {
        // Anonymous users or tokens without email — nothing to link
        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ linked: 0, skipped: 0 }) };
    }

    try {
        const db    = admin.firestore();
        const colRef = db.collection(ORDERS_PATH);

        // Find all orders matching this email across both possible field names
        const [byBuyerEmail, byEmail] = await Promise.all([
            colRef.where('buyerEmail', '==', email).get(),
            colRef.where('email',      '==', email).get(),
        ]);

        // Deduplicate
        const seen = new Set();
        const candidates = [];
        for (const snap of [byBuyerEmail, byEmail]) {
            for (const docSnap of snap.docs) {
                if (seen.has(docSnap.id)) continue;
                seen.add(docSnap.id);
                candidates.push(docSnap);
            }
        }

        if (candidates.length === 0) {
            return {
                statusCode: 200,
                headers: HEADERS,
                body: JSON.stringify({ linked: 0, skipped: 0, message: 'No orders found for this email' }),
            };
        }

        // Batch write — only patch orders that are missing or have a guest uid
        const batch    = db.batch();
        let linked     = 0;
        let skipped    = 0;
        const linkedIds = [];

        for (const docSnap of candidates) {
            const data = docSnap.data();

            // Skip if already linked to this uid
            if (data.uid === uid && data.userId === uid) {
                skipped++;
                continue;
            }

            // Skip if linked to a *different* real user (don't overwrite)
            const existingUid    = data.uid    || null;
            const existingUserId = data.userId || null;
            const isGuestOrder   = GUEST_USER_IDS.has(existingUserId) && GUEST_USER_IDS.has(existingUid);
            const alreadyOwned   = (existingUid && existingUid !== uid) ||
                                   (existingUserId && !GUEST_USER_IDS.has(existingUserId) && existingUserId !== uid);

            if (alreadyOwned) {
                skipped++;
                continue;
            }

            // Patch uid, userId, and ensure buyerEmail is canonical lowercase
            batch.update(docSnap.ref, {
                uid:        uid,
                userId:     uid,
                buyerEmail: email,   // normalise to lowercase in case it was mixed-case
                linkedAt:   admin.firestore.FieldValue.serverTimestamp(),
                updatedAt:  admin.firestore.FieldValue.serverTimestamp(),
            });

            linked++;
            linkedIds.push(docSnap.id.slice(0, 8));
        }

        if (linked > 0) {
            await batch.commit();
            console.log(`linkUserOrders: linked ${linked} order(s) to uid ${uid} (${email}): ${linkedIds.join(', ')}`);
        }

        return {
            statusCode: 200,
            headers: HEADERS,
            body: JSON.stringify({ linked, skipped }),
        };

    } catch (err) {
        console.error('linkUserOrders error:', err);
        return {
            statusCode: 500,
            headers: HEADERS,
            body: JSON.stringify({ error: 'Failed to link orders. Please try again.' }),
        };
    }
};
