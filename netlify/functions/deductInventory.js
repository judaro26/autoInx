/**
 * Netlify Function: deductInventory.js
 *
 * Server-side stock deduction — called fire-and-forget after order creation.
 * Requires a valid admin Firebase ID token OR the HMAC order signature.
 * Removes the need for the client-side stock-update Firestore rule.
 */

const admin  = require('firebase-admin');
const crypto = require('crypto');

const ORDERS_COLL = 'artifacts/default-app-id/public/data/orders';
const ITEMS_COLL  = 'artifacts/default-app-id/public/data/items';

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

function verifySignature(orderId, sig) {
    const secret = process.env.ORDER_EMAIL_SECRET;
    if (!secret || !sig) return false;
    try {
        const expected = crypto.createHmac('sha256', secret).update(orderId).digest('hex');
        return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'));
    } catch { return false; }
}

const HEADERS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': process.env.URL || 'https://autoinx.com',
};

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, headers: HEADERS, body: '{}' };

    let payload;
    try { payload = JSON.parse(event.body); }
    catch { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

    const { orderId, items, _sig } = payload;
    if (!orderId || !Array.isArray(items) || items.length === 0) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'orderId and items required' }) };
    }

    // Verify via HMAC signature (same secret used for email signing)
    if (!verifySignature(orderId, _sig)) {
        return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ error: 'Invalid signature' }) };
    }

    const db = initAdmin();

    // Verify the order actually exists to prevent forged deductions
    const orderSnap = await db.doc(`${ORDERS_COLL}/${orderId}`).get();
    if (!orderSnap.exists) {
        return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Order not found' }) };
    }

    let deducted = 0, skipped = 0;

    await Promise.all(items.map(async item => {
        if (!item.id || !item.quantity) return;
        try {
            const itemRef  = db.doc(`${ITEMS_COLL}/${item.id}`);
            const itemSnap = await itemRef.get();
            if (!itemSnap.exists) { skipped++; return; }

            const currentStock = itemSnap.data().stock || 0;
            const newStock     = Math.max(0, currentStock - item.quantity);

            await itemRef.update({
                stock:     newStock,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            deducted++;
        } catch (err) {
            console.error(`Stock deduction failed for item ${item.id}:`, err.message);
            skipped++;
        }
    }));

    console.log(`✅ Inventory deducted for order ${orderId.slice(0,8)}: ${deducted} items, ${skipped} skipped`);
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true, deducted, skipped }) };
};
