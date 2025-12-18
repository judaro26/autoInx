/**
 * Netlify Function (Admin Only) to get or initialize Admin configuration from Firestore.
 * This includes the dynamic IP Whitelist and Maintenance Mode status.
 */
const admin = require('firebase-admin');

// Ensure Firebase Admin is initialized once
if (!admin.apps.length) {
    
    const privateKeyString = process.env.FIREBASE_PRIVATE_KEY;
    let cleanedPrivateKey = undefined;

    if (privateKeyString) {
        // Handle escaped newlines from environment variables
        cleanedPrivateKey = privateKeyString
                                .replace(/\\n/g, '\n')
                                .replace(/\n/g, '\n')
                                .trim(); 
    }

    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: cleanedPrivateKey,
        }),
    });
}

const db = admin.firestore();
// Path: Collection 'admin', Document 'config'
const CONFIG_DOC_PATH = 'admin/config';

exports.handler = async function (event) {
    
    // --- START SECURITY CHECK: Validate Admin Token ---
    // This blocks public access to the IP Whitelist and other settings.
    const authHeader = event.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        // Return 401 if no token is present
        return { statusCode: 401, body: JSON.stringify({ error: 'Authorization token required for admin configuration access.' }) };
    }

    const idToken = authHeader.split('Bearer ')[1];
    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        if (decodedToken.admin !== true) {
            // Return 403 if token is present but lacks admin claim
            return { statusCode: 403, body: JSON.stringify({ error: 'Access denied: Admin privileges required.' }) };
        }
    } catch (e) {
        // Return 401 if token is invalid or expired
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired token.' }) };
    }
    // --- END SECURITY CHECK ---

    try {
        const configRef = db.doc(CONFIG_DOC_PATH);
        const configDoc = await configRef.get();

        if (!configDoc.exists) {
            // Initialize config if it doesn't exist
            const initialConfig = {
                ipWhitelist: ["127.0.0.1"], // Default IP
                maintenanceMode: false,
                chatWidgetEnabled: true, 
                lastUpdated: admin.firestore.FieldValue.serverTimestamp()
            };
            await configRef.set(initialConfig);
            console.log('Admin config initialized.');
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(initialConfig),
            };
        }
        
        const configData = configDoc.data();
        if (configData.chatWidgetEnabled === undefined) {
             configData.chatWidgetEnabled = true;
        }

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(configData),
        };

    } catch (error) {
        console.error('Error fetching admin config:', error);
        return {
            statusCode: 500, // Return 500 on server error
            body: JSON.stringify({ error: 'Failed to fetch admin configuration', details: error.message }),
        };
    }
};
