/**
 * Netlify Function (Admin Only) to update global Admin configuration in Firestore.
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
// CORRECTED PATH: Must match the path in getAdminConfig.js
const CONFIG_DOC_PATH = 'admin/config';

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    try {
        const updates = JSON.parse(event.body);

        // Basic validation
        if (!updates || Object.keys(updates).length === 0) {
            return { statusCode: 400, body: JSON.stringify({ error: 'No update fields provided' }) };
        }

        // Add lastUpdated timestamp
        updates.lastUpdated = admin.firestore.FieldValue.serverTimestamp();

        // Update the document using db.doc()
        const configRef = db.doc(CONFIG_DOC_PATH);
        await configRef.set(updates, { merge: true });

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
