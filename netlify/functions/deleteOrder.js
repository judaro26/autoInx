/**
 * Netlify Function (Admin Only) to delete a single order document.
 * SECURITY: Reads the IP whitelist directly from ip-data.json for portability.
 */
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// --- LOAD IP WHITELIST FROM LOCAL JSON FILE ---
let WHITELISTED_IPS = [];
let WHITELIST_CHECK_ENABLED = false;

try {
    // Determine the path to the JSON file relative to the function bundle
    const dataPath = path.join(__dirname, 'ip-data.json');
    const ipData = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

    WHITELISTED_IPS = ipData.whitelisted_ips.map(ip => ip.trim());
    WHITELIST_CHECK_ENABLED = ipData.check_enabled;
    console.log(`Whitelist loaded successfully. Check Enabled: ${WHITELIST_CHECK_ENABLED}`);

} catch (e) {
    console.error("FATAL: Could not load IP Whitelist file.", e.message);
    // On file read failure, default to a safe (disabled) state
    WHITELISTED_IPS = [];
    WHITELIST_CHECK_ENABLED = false;
}

// --- FIREBASE INITIALIZATION (Uses env vars for credentials) ---
if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.applicationDefault()
    });
  } catch (e) {
    console.error("Firebase Admin initialization status: Failed.", e.message);
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
    
    // --- 2. Security Check: Validate Admin Token (Remains the same) ---
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
