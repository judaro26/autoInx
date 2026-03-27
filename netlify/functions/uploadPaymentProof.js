/**
 * Netlify Function: uploadPaymentProof.js
 *
 * Accepts a multipart file upload from a guest customer (no Firebase auth)
 * and saves it to Firebase Storage, returning a signed download URL.
 *
 * No external dependencies beyond firebase-admin (already in package.json).
 * Multipart parsing is done inline without busboy.
 */

const admin = require('firebase-admin');
const path  = require('path');

const MAX_FILE_SIZE   = 5 * 1024 * 1024; // 5 MB
const ALLOWED_MIMES   = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
const ORDERS_COLL     = 'artifacts/default-app-id/public/data/orders';

const HEADERS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin':  process.env.URL || 'https://autoinx.com',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

function initAdmin() {
    if (admin.apps.length === 0) {
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId:   process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            }),
            storageBucket: process.env.FIREBASE_STORAGE_BUCKET ||
                           `${process.env.FIREBASE_PROJECT_ID}.appspot.com`,
        });
    }
    return { db: admin.firestore(), bucket: admin.storage().bucket() };
}

// ── Minimal multipart parser (no busboy needed) ───────────────────────────────
function parseMultipart(body, contentType) {
    const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
    if (!boundaryMatch) throw new Error('No boundary found in Content-Type');
    const boundary = '--' + boundaryMatch[1];

    const fields = {};
    let fileBuffer = null;
    let fileName   = 'upload';
    let fileMime   = 'application/octet-stream';

    // Split on boundary lines
    const parts = body.split(boundary).slice(1); // skip preamble

    for (const part of parts) {
        if (part.trim() === '--' || part.trim() === '--\r\n') continue; // end boundary

        // Find the blank line separating headers from body
        const headerBodySplit = part.indexOf('\r\n\r\n');
        if (headerBodySplit === -1) continue;

        const headerSection = part.substring(0, headerBodySplit);
        // Body: everything after the blank line, minus trailing \r\n--
        let bodySection = part.substring(headerBodySplit + 4);
        // Strip trailing \r\n
        if (bodySection.endsWith('\r\n')) bodySection = bodySection.slice(0, -2);

        const dispositionMatch = headerSection.match(/Content-Disposition:[^\r\n]*name="([^"]+)"/i);
        const fileNameMatch    = headerSection.match(/Content-Disposition:[^\r\n]*filename="([^"]+)"/i);
        const mimeMatch        = headerSection.match(/Content-Type:\s*([^\r\n]+)/i);

        const fieldName = dispositionMatch ? dispositionMatch[1] : null;

        if (fileNameMatch) {
            // This is a file part
            fileName = fileNameMatch[1];
            fileMime = mimeMatch ? mimeMatch[1].trim() : 'application/octet-stream';
            fileBuffer = Buffer.from(bodySection, 'binary');
        } else if (fieldName) {
            // Regular text field
            fields[fieldName] = bodySection;
        }
    }

    return { fields, fileBuffer, fileName, fileMime };
}

// ── Handler ───────────────────────────────────────────────────────────────────
exports.handler = async function (event) {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: '' };
    if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };

    const contentType = event.headers['content-type'] || event.headers['Content-Type'] || '';
    if (!contentType.includes('multipart/form-data')) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Expected multipart/form-data' }) };
    }

    try {
        // Decode body
        const rawBody = event.isBase64Encoded
            ? Buffer.from(event.body, 'base64').toString('binary')
            : event.body;

        let parsed;
        try {
            parsed = parseMultipart(rawBody, contentType);
        } catch (err) {
            return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Failed to parse upload: ' + err.message }) };
        }

        const { fields, fileBuffer, fileName, fileMime } = parsed;
        const orderId = (fields.orderId || '').trim();
        const email   = (fields.email   || '').trim();

        if (!orderId) {
            return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'orderId is required' }) };
        }
        if (!fileBuffer || fileBuffer.length === 0) {
            return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'No file received' }) };
        }
        if (fileBuffer.length > MAX_FILE_SIZE) {
            return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'File too large (max 5 MB)' }) };
        }
        if (!ALLOWED_MIMES.includes(fileMime)) {
            return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: `File type not allowed: ${fileMime}` }) };
        }

        const { db, bucket } = initAdmin();

        // Verify order exists and email matches
        const orderSnap = await db.doc(`${ORDERS_COLL}/${orderId}`).get();
        if (!orderSnap.exists) {
            return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Order not found' }) };
        }
        if (email) {
            const orderEmail = (orderSnap.data().buyerEmail || '').toLowerCase().trim();
            if (orderEmail && orderEmail !== email.toLowerCase()) {
                return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ error: 'Email does not match order' }) };
            }
        }

        // Upload to Firebase Storage
        const ext      = path.extname(fileName) || (fileMime === 'application/pdf' ? '.pdf' : '.jpg');
        const filePath = `payment_confirmations/${orderId}/${Date.now()}${ext}`;
        const fileRef  = bucket.file(filePath);

        await fileRef.save(Buffer.from(fileBuffer, 'binary'), {
            metadata: { contentType: fileMime },
            public: false,
        });

        const [signedUrl] = await fileRef.getSignedUrl({
            action:  'read',
            expires: '2035-01-01',
        });

        console.log(`✅ Payment proof uploaded: ${filePath}`);
        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true, url: signedUrl }) };

    } catch (err) {
        console.error('uploadPaymentProof error:', err);
        return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
    }
};
