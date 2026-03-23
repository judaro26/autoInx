/**
 * saveExternalOrder.js
 *
 * Creates or updates an external order in Firestore.
 *
 * eBay orders (platform === 'eBay') have PROTECTED fields that only the
 * eBay sync function may write. The admin can only change:
 *   core doc:  status, notes
 *   pricing:   vendorCostPerUnit, productId, quantity
 *
 * Manual orders allow full field updates.
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
        getDb();
        const decoded = await admin.auth().verifyIdToken(authHeader.replace('Bearer ', ''));
        if (!decoded.admin) {
            return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ error: 'Admin access required' }) };
        }
    } catch (err) {
        console.error('Token verification failed:', err.message);
        return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: 'Invalid token' }) };
    }

    let body;
    try { body = JSON.parse(event.body); }
    catch { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

    const {
        id, platform, externalOrderId, customerName, orderDate,
        product, status, amount, trackingNumber, notes,
        // pricing fields (always admin-settable)
        vendorCostPerUnit, productId, quantity,
        shippingCharged, transactionCost,
    } = body;

    const isEbay = (platform || '').toLowerCase() === 'ebay';
    const isNew  = !id;

    if (!platform || !customerName || !orderDate || !product) {
        return { statusCode: 400, headers: HEADERS,
            body: JSON.stringify({ error: 'Missing required fields: platform, customerName, orderDate, product' }) };
    }

    try {
        const db  = getDb();
        const now = admin.firestore.FieldValue.serverTimestamp();
        const col = db.collection('external_orders');

        const docRef = id ? col.doc(id) : col.doc();

        if (isEbay && !isNew) {
            // ── eBay existing order: only write admin-safe fields ─────────────
            // NEVER overwrite amount, shippingCharged, transactionCost — eBay-owned.
            // Tracking IS writable: eBay API doesn't always provide it, admin may know it.
            const ebayUpdate = {
                status:    status || 'Pending',
                notes:     notes  || null,
                updatedAt: now,
            };
            // Only write tracking if admin explicitly provided a value
            if (trackingNumber) ebayUpdate.trackingNumber = trackingNumber;

            await docRef.set(ebayUpdate, { merge: true });
            console.log(`✅ eBay order ${docRef.id}: updated status/notes/tracking`);

        } else if (isNew) {
            // ── New manual order ──────────────────────────────────────────────
            await docRef.set({
                platform:        platform        || 'Manual',
                externalOrderId: externalOrderId || docRef.id,
                customerName:    customerName    || '',
                orderDate:       orderDate       || '',
                product:         product         || '',
                status:          status          || 'Pending',
                amount:          parseFloat(amount) || 0,
                trackingNumber:  trackingNumber  || null,
                notes:           notes           || null,
                createdAt:       now,
                updatedAt:       now,
            });
            console.log(`✅ Created manual external order: ${docRef.id}`);

        } else {
            // ── Existing manual order: full update ────────────────────────────
            await docRef.set({
                platform:        platform        || 'Manual',
                externalOrderId: externalOrderId || docRef.id,
                customerName:    customerName    || '',
                orderDate:       orderDate       || '',
                product:         product         || '',
                status:          status          || 'Pending',
                amount:          parseFloat(amount) || 0,
                trackingNumber:  trackingNumber  || null,
                notes:           notes           || null,
                updatedAt:       now,
            }, { merge: true });
            console.log(`✅ Updated manual external order: ${docRef.id}`);
        }

        // ── Pricing doc: always update admin-editable fields ─────────────────
        // For eBay orders we only write vendorCostPerUnit and productId.
        // shippingCharged and transactionCost are eBay-owned — only write for manual orders.
        const pricingUpdate = {
            vendorCostPerUnit: vendorCostPerUnit != null ? vendorCostPerUnit : null,
            productId:         productId         || null,
            quantity:          parseInt(quantity) || 1,
            updatedAt:         now,
        };
        if (!isEbay) {
            pricingUpdate.shippingCharged  = parseFloat(shippingCharged)  || 0;
            pricingUpdate.transactionCost  = parseFloat(transactionCost)  || 0;
        }

        await db.collection('external_order_pricing').doc(docRef.id).set(
            pricingUpdate, { merge: true }
        );

        return {
            statusCode: 200,
            headers: HEADERS,
            body: JSON.stringify({ success: true, id: docRef.id, orderId: docRef.id, isNew }),
        };

    } catch (err) {
        console.error('❌ saveExternalOrder error:', err);
        return { statusCode: 500, headers: HEADERS,
            body: JSON.stringify({ error: 'Failed to save order', details: err.message }) };
    }
};
