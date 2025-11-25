/**
 * Netlify Function (Admin Only) to update global Admin configuration in Firestore.
 */
const admin = require('firebase-admin');

// Ensure Firebase Admin is initialized once
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
        }),
    });
}

const db = admin.firestore();
const CONFIG_DOC_PATH = 'admin/config';

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    // --- 1. CRITICAL SECURITY CHECK: Validate Admin Token ---
    const authHeader = event.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Authorization token required.' }) };
    }

    const idToken = authHeader.split('Bearer ')[1];
    let decodedToken;
    try {
        decodedToken = await admin.auth().verifyIdToken(idToken);
    } catch (e) {
        // Log the error for debugging, but return a generic 401 to the client
        console.error('Token verification failed:', e.message);
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired token.' }) };
    }

    if (decodedToken.admin !== true) {
        return { statusCode: 403, body: JSON.stringify({ error: 'Access denied: Admin privileges required.' }) };
    }
    // --- End Security Check ---

    try {
        const updates = JSON.parse(event.body);

        // Basic validation (body should not be empty)
        if (!updates || Object.keys(updates).length === 0) {
            return { statusCode: 400, body: JSON.stringify({ error: 'No update fields provided' }) };
        }
        
        // --- 2. Input Filtering (Highly Recommended) ---
        // Only allow specific fields to be updated to prevent abuse
        const allowedUpdates = {};
        if (updates.hasOwnProperty('maintenanceMode')) {
            allowedUpdates.maintenanceMode = !!updates.maintenanceMode; // Coerce to boolean
        }
        if (updates.hasOwnProperty('chatWidgetEnabled')) {
            allowedUpdates.chatWidgetEnabled = !!updates.chatWidgetEnabled; // Coerce to boolean
        }
        if (updates.hasOwnProperty('ipWhitelist') && Array.isArray(updates.ipWhitelist)) {
            allowedUpdates.ipWhitelist = updates.ipWhitelist.filter(ip => typeof ip === 'string'); // Filter for strings
        }

        if (Object.keys(allowedUpdates).length === 0) {
            return { statusCode: 400, body: JSON.stringify({ error: 'No valid update fields provided' }) };
        }
        
        // Add lastUpdated timestamp
        allowedUpdates.lastUpdated = admin.firestore.FieldValue.serverTimestamp();

        // Update the document using db.doc()
        const configRef = db.doc(CONFIG_DOC_PATH);
        await configRef.set(allowedUpdates, { merge: true }); // Use allowedUpdates

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'Configuration updated successfully' }),
        };

    } catch (error) {
        console.error('Error updating admin config:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to update configuration', details: error.message }),
        };
    }
};
