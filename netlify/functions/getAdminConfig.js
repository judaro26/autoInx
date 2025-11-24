/**
 * Netlify Function to get or initialize Admin configuration from Firestore.
 * This includes the dynamic IP Whitelist and Maintenance Mode status.
 */
const admin = require('firebase-admin');

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
    try {
        const configRef = db.collection('config').doc(CONFIG_DOC_PATH);
        const configDoc = await configRef.get();

        if (!configDoc.exists) {
            // Initialize config if it doesn't exist
            const initialConfig = {
                ipWhitelist: ["127.0.0.1"], // Default IP
                maintenanceMode: false,
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

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(configDoc.data()),
        };

    } catch (error) {
        console.error('Error fetching admin config:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to fetch admin configuration' }),
        };
    }
};
