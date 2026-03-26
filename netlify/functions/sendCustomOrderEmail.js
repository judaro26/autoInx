/**
 * Netlify Function: sendCustomOrderEmail.js
 *
 * Sends a custom HTML email to a customer about their order.
 * Called from the admin panel's Custom Email composer.
 *
 * Auth: requires a valid Firebase ID token with admin claim.
 * The HTML body is built client-side in admin.html and sent here as-is.
 * This function handles delivery via the same email provider as other
 * order emails (reuses the existing mailer setup).
 */

const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

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

function getTransporter() {
    // Matches the exact env vars used by sendOrderConfirmation.js (Brevo SMTP)
    return nodemailer.createTransport({
        host:   process.env.BREVO_SMTP_HOST,
        port:   parseInt(process.env.BREVO_SMTP_PORT || '587'),
        secure: false,
        auth: {
            user: process.env.BREVO_SMTP_USER,
            pass: process.env.BREVO_SMTP_PASSWORD,
        },
    });
}

const HEADERS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': process.env.URL || 'https://autoinx.com',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

exports.handler = async function(event) {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: HEADERS, body: '' };
    }
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    // ── Verify admin token ────────────────────────────────────────────────────
    initAdmin();

    const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
    const idToken    = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!idToken) {
        return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: 'Missing Authorization header' }) };
    }

    let decoded;
    try {
        decoded = await admin.auth().verifyIdToken(idToken);
    } catch {
        return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: 'Invalid or expired token' }) };
    }

    if (!decoded.admin) {
        return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ error: 'Admin access required' }) };
    }

    // ── Parse body ────────────────────────────────────────────────────────────
    let payload;
    try {
        payload = JSON.parse(event.body);
    } catch {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }

    const {
        toEmail, toName, subject, htmlBody,
        orderId, orderNum, emailType,
        storeName, adminEmail,
    } = payload;

    if (!toEmail || !htmlBody || !subject) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'toEmail, subject, and htmlBody are required' }) };
    }

    // ── Send email ────────────────────────────────────────────────────────────
    try {
        const transporter = getTransporter();
        const fromName    = storeName || 'AutoInx';

        await transporter.sendMail({
            from:    `"${fromName}" <noreply@autoinx.com>`,
            to:      toName ? `"${toName}" <${toEmail}>` : toEmail,
            subject,
            html:    htmlBody,
            replyTo: `support@autoinx.com`,
        });

        // Log to Firestore for the Email Log tab
        try {
            const db = admin.firestore();
            await db.collection('email_notifications').add({
                type:        'custom_order_email',
                emailType:   emailType || 'custom',
                orderId:     orderId || null,
                orderNumber: orderNum || null,
                toEmail,
                toName:      toName || null,
                subject,
                sentBy:      adminEmail || decoded.email || 'admin',
                sentAt:      admin.firestore.FieldValue.serverTimestamp(),
                status:      'sent',
            });
        } catch (logErr) {
            console.warn('Email log write failed:', logErr.message);
            // Non-fatal — email already sent
        }

        console.log(`✅ Custom order email sent to ${toEmail} (order ${orderId})`);

        return {
            statusCode: 200,
            headers: HEADERS,
            body: JSON.stringify({ success: true }),
        };

    } catch (err) {
        console.error('sendCustomOrderEmail error:', err);
        return {
            statusCode: 500,
            headers: HEADERS,
            body: JSON.stringify({ error: err.message || 'Failed to send email' }),
        };
    }
};
