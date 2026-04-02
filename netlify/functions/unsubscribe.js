/**
 * Netlify Function: unsubscribe.js
 * Handles email unsubscribe requests via GET link in emails.
 * URL: /.netlify/functions/unsubscribe?email=user@example.com&token=HMAC
 *
 * Token = HMAC-SHA256(email, UNSUBSCRIBE_SECRET) — prevents forged unsubscribes.
 */

const admin  = require('firebase-admin');
const crypto = require('crypto');

const SECRET = process.env.UNSUBSCRIBE_SECRET || 'autoinx-unsub-secret-change-me';

function makeToken(email) {
    return crypto.createHmac('sha256', SECRET).update(email.toLowerCase()).digest('hex').slice(0, 32);
}

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

exports.handler = async function(event) {
    const qs    = event.queryStringParameters || {};
    const email = (qs.email || '').trim().toLowerCase();
    const token = (qs.token || '').trim();

    const page = (title, msg, color) => ({
        statusCode: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        body: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — AutoInx</title>
<style>body{font-family:Inter,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f0f4ff;}
.card{background:#fff;border-radius:16px;padding:2.5rem;max-width:420px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08);}
.icon{font-size:3rem;margin-bottom:1rem;}h1{font-size:1.4rem;font-weight:800;color:#1f2937;margin:0 0 .75rem;}
p{color:#6b7280;font-size:.95rem;line-height:1.6;margin:0 0 1.5rem;}
a{display:inline-block;padding:.7rem 1.8rem;background:#4f46e5;color:#fff;border-radius:10px;font-weight:700;text-decoration:none;font-size:.9rem;}
</style></head><body><div class="card">
<div class="icon">${color === 'green' ? '✅' : color === 'yellow' ? '⚠️' : '❌'}</div>
<h1>${title}</h1><p>${msg}</p>
<a href="https://autoinx.com">← Back to AutoInx</a>
</div></body></html>`
    });

    if (!email || !token) {
        return page('Invalid Link', 'This unsubscribe link is missing required information. Please contact support@autoinx.com.', 'red');
    }

    // Verify token
    const expected = makeToken(email);
    if (token !== expected) {
        return page('Invalid Link', 'This unsubscribe link is expired or invalid. Please contact support@autoinx.com to unsubscribe manually.', 'red');
    }

    try {
        const db = initAdmin();

        // Find subscriber record by email
        const snap = await db.collection('email_subscribers')
            .where('email', '==', email)
            .limit(1)
            .get();

        if (snap.empty) {
            return page('Already Unsubscribed', `${email} is not on our mailing list, or was already removed.`, 'yellow');
        }

        // Mark as unsubscribed
        await snap.docs[0].ref.update({
            active:         false,
            unsubscribedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        return page('Unsubscribed', `${email} has been removed from our email list. You won't receive any more marketing emails from AutoInx.`, 'green');

    } catch (err) {
        console.error('Unsubscribe error:', err);
        return page('Error', 'Something went wrong. Please email support@autoinx.com to unsubscribe manually.', 'red');
    }
};

// Export token generator so sendOrderConfirmation.js can use it
module.exports.makeToken = makeToken;
