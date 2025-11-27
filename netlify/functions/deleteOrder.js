/**
 * Netlify Function (Admin Only) to delete a single order document.
 * * FIXES INCLUDED:
 * 1. Robust Firebase Admin initialization using explicit environment variables (to fix ENOTFOUND).
 * 2. Whitelist read from bundled ip-data.json (assuming netlify.toml bundles the file).
 */
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// --- LOAD IP WHITELIST FROM LOCAL JSON FILE ---
let WHITELISTED_IPS = [];
let WHITELIST_CHECK_ENABLED = false;

try {
    // Determine the path to the JSON file relative to the function bundle
    // NOTE: '__dirname' points to the directory containing the bundled function.
    const dataPath = path.join(__dirname, 'ip-data.json');
    const ipData = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

    WHITELISTED_IPS = ipData.whitelisted_ips.map(ip => ip.trim());
    WHITELIST_CHECK_ENABLED = ipData.check_enabled;
    console.log(`Whitelist loaded successfully. Check Enabled: ${WHITELIST_CHECK_ENABLED}`);

} catch (e) {
    console.error("FATAL: Could not load IP Whitelist file. Ensure 'ip-data.json' is bundled via netlify.toml.", e.message);
    // Default to a safe (disabled) state if the config file is missing
    WHITELISTED_IPS = [];
    WHITELIST_CHECK_ENABLED = false;
}

// --- FIREBASE INITIALIZATION FIX (CRITICAL) ---
if (!admin.apps.length) {
    try {
        // FIX: Explicitly use credentials from environment variables to bypass the metadata server check
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                // Replace escaped newlines in the private key
                privateKey: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
            }),
        });
    } catch (e) {
        console.error("Firebase Admin initialization status: FAILED (Check environment variables).", e.message);
    }
}

const db = admin.firestore();

// This still requires ORDERS_COLLECTION_PATH env variable for the collection path
const ORDERS_COLLECTION = process.env.ORDERS_COLLECTION_PATH || 'artifacts/default-app-id/public/data/orders';

exports.handler = async function (event, context) {
    if (event.httpMethod !== 'DELETE') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }
    
    // --- 1. IP Whitelist Check (Server-Side Enforcement) ---
    const clientIP = event.headers['x-nf-client-connection-ip'] || event.headers['client-ip'];
    
    if (WHITELIST_CHECK_ENABLED && WHITELISTED_IPS.length > 0) {
        if (!clientIP || !WHITELISTED_IPS.includes(clientIP)) {
            console.warn(`ACCESS DENIED: IP ${clientIP} not in whitelist.`);
            return { statusCode: 403, body: JSON.stringify({ error: 'Access denied: IP not authorized for this action.' }) };
        }
    }
    
    // --- 2. Security Check: Validate Admin Token ---
    const authHeader = event.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Authorization token required.' }) };
    }

    const idToken = authHeader.split('Bearer ')[1];
    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        if (decodedToken.admin !== true) {
            return { statusCode: 403, body: JSON.stringify({ error: 'Access denied: Admin privileges required.' }) };
        }
    } catch (e) {
        console.error("Token verification failed:", e.message);
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired token.' }) };
    }

    // --- 3. Execution ---
    const orderId = event.queryStringParameters.orderId;
    if (!orderId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing required query parameter: orderId' }) };
    }

    try {
        const orderRef = db.collection(ORDERS_COLLECTION).doc(orderId);
        
        const docSnapshot = await orderRef.get();
        if (!docSnapshot.exists) {
            return { statusCode: 404, body: JSON.stringify({ error: `Order ${orderId} not found.` }) };
        }

        await orderRef.delete();

        console.log(`Order ${orderId} deleted by Admin.`);
        
        return {
            statusCode: 200,
            body: JSON.stringify({ message: `Order ${orderId} successfully deleted.`, orderId: orderId }),
        };

    } catch (error) {
        console.error(`Error deleting order ${orderId}:`, error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to delete order', details: error.message }),
        };
    }
};
