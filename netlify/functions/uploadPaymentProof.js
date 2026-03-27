/**
 * Netlify Function: uploadPaymentProof.js
 *
 * Accepts a multipart file upload from a guest customer (no Firebase auth)
 * and saves it to Firebase Storage, returning the download URL.
 *
 * Called by the guest payment confirmation panel in track-order.html.
 * Authentication: verifies orderId exists and email matches before storing.
 */

const admin   = require('firebase-admin');
const busboy  = require('busboy');
const path    = require('path');

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

const ALLOWED_TYPES = [
    'image/jpeg', 'image/png', 'image/webp', 'image/gif',
    'application/pdf'
];

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
    return {
        db:      admin.firestore(),
        bucket:  admin.storage().bucket(),
    };
}

const HEADERS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin':  process.env.URL || 'https://autoinx.com',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

const ORDERS_COLL = 'artifacts/default-app-id/public/data/orders';

// Parse multipart form data using busboy
function parseMultipart(event) {
    return new Promise((resolve, reject) => {
        const fields = {};
        let fileBuffer = null;
        let fileName   = '';
        let fileMime   = '';
        let fileSize   = 0;

        const bb = busboy({
            headers: { 'content-type': event.headers['content-type'] || event.headers['Content-Type'] },
            limits: { fileSize: MAX_FILE_SIZE },
        });

        bb.on('field', (name, val) => { fields[name] = val; });

        bb.on('file', (name, stream, info) => {
            fileName = info.filename || 'upload';
            fileMime = info.mimeType || 'application/octet-stream';
            const chunks = [];

            stream.on('data', chunk => {
                fileSize += chunk.length;
                chunks.push(chunk);
            });
            stream.on('limit', () => {
                reject(new Error('File too large (max 5 MB)'));
            });
            stream.on('end', () => {
                fileBuffer = Buffer.concat(chunks);
            });
        });

        bb.on('finish', () => resolve({ fields, fileBuffer, fileName, fileMime, fileSize }));
        bb.on('error', reject);

        // Feed the body into busboy
        const body = event.isBase64Encoded
            ? Buffer.from(event.body, 'base64')
            : Buffer.from(event.body || '');
        bb.write(body);
        bb.end();
    });
}

exports.handler = async function (event) {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: '' };
    if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };

    try {
        const { db, bucket } = initAdmin();

        // Parse multipart body
        let parsed;
        try {
            parsed = await parseMultipart(event);
        } catch (err) {
            return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: err.message || 'Failed to parse upload' }) };
        }

        const { fields, fileBuffer, fileName, fileMime } = parsed;
        const { orderId, email } = fields;

        if (!orderId) {
            return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'orderId is required' }) };
        }

        // Validate file
        if (!fileBuffer || fileBuffer.length === 0) {
            return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'No file received' }) };
        }
        if (!ALLOWED_TYPES.includes(fileMime)) {
            return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: `File type not allowed: ${fileMime}` }) };
        }

        // Verify order exists and email matches (security check)
        const orderSnap = await db.doc(`${ORDERS_COLL}/${orderId}`).get();
        if (!orderSnap.exists) {
            return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ error: 'Order not found' }) };
        }

        if (email) {
            const orderEmail = (orderSnap.data().buyerEmail || '').toLowerCase().trim();
            if (orderEmail && orderEmail !== email.toLowerCase().trim()) {
                return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ error: 'Email does not match order' }) };
            }
        }

        // Build storage path
        const ext       = path.extname(fileName) || (fileMime === 'application/pdf' ? '.pdf' : '.jpg');
        const safeName  = `${Date.now()}${ext}`;
        const filePath  = `payment_confirmations/${orderId}/${safeName}`;
        const fileRef   = bucket.file(filePath);

        // Upload to Firebase Storage
        await fileRef.save(fileBuffer, {
            metadata: {
                contentType: fileMime,
                metadata: { orderId, uploadedAt: new Date().toISOString() }
            },
            public: false,
        });

        // Generate a signed URL valid for 10 years (effectively permanent for proof docs)
        const [signedUrl] = await fileRef.getSignedUrl({
            action:  'read',
            expires: '2035-01-01',
        });

        console.log(`✅ Payment proof uploaded for order ${orderId.slice(0,8)}: ${filePath}`);

        return {
            statusCode: 200,
            headers: HEADERS,
            body: JSON.stringify({ success: true, url: signedUrl }),
        };

    } catch (err) {
        console.error('uploadPaymentProof error:', err);
        return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
    }
};
