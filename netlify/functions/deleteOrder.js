/**
 * Netlify Function (Admin Only) to delete a single order document.
 */
const admin = require('firebase-admin');

// --- CONFIGURATION ---
const WHITELIST_CHECK_ENABLED = true; 
const ORDERS_COLLECTION = process.env.ORDERS_COLLECTION_PATH || 'artifacts/default-app-id/public/data/orders';

// --- FIREBASE INITIALIZATION ---
if (!admin.apps.length) {
    try {
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
            }),
        });
    } catch (e) {
        console.error("Firebase Admin initialization status: FAILED.", e.message);
    }
}

const db = admin.firestore();

exports.handler = async function (event, context) {
    // Only allow DELETE requests
    if (event.httpMethod !== 'DELETE') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    // --- 1. LOAD IP WHITELIST (Dynamic Import from ES Module) ---
    let whitelistedIps = [];
    try {
        // Points to netlify/functions/js/utilities/ipWhitelist.js
        const whitelistModule = await import('./js/utilities/ipWhitelist.js');
        whitelistedIps = whitelistModule.ipWhitelist || [];
    } catch (e) {
        console.error("Warning: Could not load IP Whitelist utility file.", e.message);
    }

    // --- 2. IP Whitelist Check ---
    const clientIP = event.headers['x-nf-client-connection-ip'] || event.headers['client-ip'];
    
    if (WHITELIST_CHECK_ENABLED && whitelistedIps.length > 0) {
        if (!clientIP || !whitelistedIps.includes(clientIP)) {
            console.warn(`ACCESS DENIED: IP ${clientIP} not in whitelist.`);
            return { 
                statusCode: 403, 
                body: JSON.stringify({ error: 'Access denied: IP not authorized for this action.' }) 
            };
        }
    }

    // --- 3. Security Check: Validate Admin Token ---
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

    // --- 4. Execution ---
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
        console.log(`Order ${orderId} deleted by Admin (IP: ${clientIP}).`);

        return {
            statusCode: 200,
            body: JSON.stringify({ 
                message: `Order ${orderId} successfully deleted.`, 
                orderId: orderId 
            }),
        };

    } catch (error) {
        console.error(`Error deleting order ${orderId}:`, error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to delete order', details: error.message }),
        };
    }
};
