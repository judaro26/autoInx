/**
 * Netlify Function (Admin Only) to log catalog and product modifications to Firestore.
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
// Path: Collection 'admin', Document 'logs', Subcollection 'catalogActions'
const LOGS_COLLECTION_PATH = 'admin/logs/catalogActions';

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    let logEntry;
    try {
        logEntry = JSON.parse(event.body);
    } catch (error) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }

    const { actionType, details, performedByEmail, objectId } = logEntry;

    if (!actionType || !performedByEmail) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields: actionType or performedByEmail' }) };
    }

    try {
        // Save the log entry
        await db.collection(LOGS_COLLECTION_PATH).add({
            actionType, // e.g., 'CATALOG_CREATED', 'ITEM_DELETED'
            objectId: objectId || null,
            details: details || {},
            performedByEmail,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'Admin action logged successfully' }),
        };

    } catch (error) {
        console.error('Error logging admin action:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to log admin action', details: error.message }),
        };
    }
};
