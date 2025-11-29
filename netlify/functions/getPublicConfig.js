/**
 * Netlify Function (Public Access) to safely serve non-sensitive Admin configuration.
 * Exposes: maintenanceMode and chatWidgetEnabled.
 */
const admin = require('firebase-admin');

// Ensure Firebase Admin is initialized once
if (!admin.apps.length) {
    
    const privateKeyString = process.env.FIREBASE_PRIVATE_KEY;
    let cleanedPrivateKey = undefined;

    if (privateKeyString) {
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
const CONFIG_DOC_PATH = 'admin/config';

exports.handler = async function (event) {
    try {
        const configRef = db.doc(CONFIG_DOC_PATH);
        const configDoc = await configRef.get();

        if (!configDoc.exists) {
            // If config is missing, return a safe default
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ maintenanceMode: true, chatWidgetEnabled: false }),
            };
        }
        
        const configData = configDoc.data();
        
        // CRITICAL: ONLY return non-sensitive fields
        const publicConfig = {
            maintenanceMode: configData.maintenanceMode === true,
            chatWidgetEnabled: configData.chatWidgetEnabled !== false,
        };

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(publicConfig),
        };

    } catch (error) {
        console.error('Error fetching public config:', error);
        return {
            statusCode: 500, 
            body: JSON.stringify({ error: 'Failed to fetch public configuration' }),
        };
    }
};
