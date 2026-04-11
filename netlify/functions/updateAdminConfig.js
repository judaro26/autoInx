/**
 * Netlify Function: updateAdminConfig.js
 *
 * Saves site configuration to Firestore (admin/config).
 * Requires a valid Firebase ID token with admin custom claim.
 * Never trusts Firestore client-side rules alone — always verifies server-side.
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
    return admin.firestore();
}

const HEADERS = {
    'Content-Type':                 'application/json',
    'Access-Control-Allow-Origin':  process.env.URL || 'https://autoinx.com',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Whitelist of top-level config keys the admin panel is allowed to write.
// Prevents injection of arbitrary keys into the config document.
const ALLOWED_KEYS = [
    'maintenanceMode',
    'chatWidgetEnabled',
    'searchDemoBanner',
    'ipWhitelist',
    'chatSchedule',
    'branding',
    'seasonalBanner',
    'payment',
    'sms',
    'footer',
];

// Within 'payment', only allow Zelle contact details — not arbitrary sub-keys
function sanitizePaymentWrite(payment) {
    if (!payment || typeof payment !== 'object') return {};
    return {
        zelleEmail: typeof payment.zelleEmail === 'string' ? payment.zelleEmail.trim() : null,
        zelleName:  typeof payment.zelleName  === 'string' ? payment.zelleName.trim()  : null,
    };
}

// Within 'sms', only allow the sender phone number
function sanitizeSmsWrite(sms) {
    if (!sms || typeof sms !== 'object') return {};
    return {
        senderPhone: typeof sms.senderPhone === 'string' ? sms.senderPhone.trim() : null,
    };
}

// Within 'footer', only allow known contact/location sub-keys
function sanitizeFooterWrite(footer) {
    if (!footer || typeof footer !== 'object') return {};
    const contacts  = footer.contacts  && typeof footer.contacts  === 'object' ? {
        phoneUS:      typeof footer.contacts.phoneUS      === 'string' ? footer.contacts.phoneUS.trim()      : null,
        phoneCO:      typeof footer.contacts.phoneCO      === 'string' ? footer.contacts.phoneCO.trim()      : null,
        supportEmail: typeof footer.contacts.supportEmail === 'string' ? footer.contacts.supportEmail.trim() : null,
        ordersEmail:  typeof footer.contacts.ordersEmail  === 'string' ? footer.contacts.ordersEmail.trim()  : null,
    } : {};
    const locations = footer.locations && typeof footer.locations === 'object' ? {
        usa:      typeof footer.locations.usa      === 'string' ? footer.locations.usa.trim() : null,
        colombia: Array.isArray(footer.locations.colombia)
            ? footer.locations.colombia.filter(a => typeof a === 'string').map(a => a.trim())
            : [],
    } : {};
    return {
        companyName: typeof footer.companyName === 'string' ? footer.companyName.trim() : null,
        tagline: footer.tagline && typeof footer.tagline === 'object' ? {
            en: typeof footer.tagline.en === 'string' ? footer.tagline.en.trim() : null,
            es: typeof footer.tagline.es === 'string' ? footer.tagline.es.trim() : null,
        } : null,
        contacts,
        locations,
    };
}

exports.handler = async function (event) {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: '' };
    if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };

    // ── Verify admin token ────────────────────────────────────────────────────
    const db         = initAdmin();
    const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
    const idToken    = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!idToken) {
        return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: 'Missing Authorization header' }) };
    }

    let decoded;
    try {
        decoded = await admin.auth().verifyIdToken(idToken);
    } catch (e) {
        return { statusCode: 401, headers: HEADERS, body: JSON.stringify({ error: 'Invalid or expired token' }) };
    }

    if (!decoded.admin) {
        console.warn(`⚠️ Non-admin user ${decoded.uid} attempted to update config`);
        return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ error: 'Admin access required' }) };
    }

    // ── Parse and sanitize payload ────────────────────────────────────────────
    let updates;
    try {
        updates = JSON.parse(event.body);
    } catch {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }

    // Strip any keys not in the whitelist
    const sanitized = {};
    for (const key of ALLOWED_KEYS) {
        if (updates[key] !== undefined) {
            sanitized[key] = key === 'payment'
                ? sanitizePaymentWrite(updates[key])
                : key === 'sms'
                ? sanitizeSmsWrite(updates[key])
                : key === 'footer'
                ? sanitizeFooterWrite(updates[key])
                : updates[key];
        }
    }

    if (Object.keys(sanitized).length === 0) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'No valid fields to update' }) };
    }

    // ── Write to Firestore ────────────────────────────────────────────────────
    try {
        sanitized.lastUpdated  = admin.firestore.FieldValue.serverTimestamp();
        sanitized.lastUpdatedBy = decoded.email || decoded.uid;

        await db.collection('admin').doc('config').set(sanitized, { merge: true });

        // Bust the sibling module cache if running in the same Lambda instance
        try {
            const getPublicConfig = require('./getPublicConfig');
            if (typeof getPublicConfig.clearCache === 'function') {
                getPublicConfig.clearCache();
                console.log('✅ Config cache cleared');
            }
        } catch { /* different instances — cache will expire naturally */ }

        console.log(`✅ Config updated by ${decoded.email || decoded.uid}:`, Object.keys(sanitized).join(', '));

        return {
            statusCode: 200,
            headers: HEADERS,
            body: JSON.stringify({ success: true, updatedKeys: Object.keys(sanitized) }),
        };
    } catch (err) {
        console.error('❌ Config update error:', err);
        return {
            statusCode: 500,
            headers: HEADERS,
            body: JSON.stringify({ error: 'Failed to update config', details: err.message }),
        };
    }
};
