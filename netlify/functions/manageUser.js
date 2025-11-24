/**
 * Netlify Function (Admin Only) to reset a user's password, delete a user, or update a user.
 * Requires Firebase Admin SDK and admin: true custom claim validation.
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

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed, only POST is allowed' }) };
    }

    let requestBody;
    try {
        requestBody = JSON.parse(event.body);
    } catch (error) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }

    const { action, uid, data } = requestBody;

    if (!uid || !action) {
        return { statusCode: 400, body: JSON.stringify({ error: 'User UID and action are required' }) };
    }

    // --- 1. Security Check: Validate Admin Token ---
    const authHeader = event.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Authorization token required.' }) };
    }

    const idToken = authHeader.split('Bearer ')[1];
    let decodedToken;
    try {
        decodedToken = await admin.auth().verifyIdToken(idToken);
    } catch (e) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired token.' }) };
    }

    if (decodedToken.admin !== true) {
        return { statusCode: 403, body: JSON.stringify({ error: 'Access denied: Admin privileges required.' }) };
    }
    // --- End Security Check ---

    try {
        let message = '';
        
        switch (action) {
            case 'delete':
                await admin.auth().deleteUser(uid);
                message = `User ${uid} deleted successfully.`;
                break;
                
            case 'update':
                if (!data || Object.keys(data).length === 0) {
                    return { statusCode: 400, body: JSON.stringify({ error: 'Data is required for update action.' }) };
                }
                await admin.auth().updateUser(uid, data);
                message = `User ${uid} updated successfully.`;
                break;
                
            case 'resetPassword':
                if (!data || !data.newPassword) {
                    return { statusCode: 400, body: JSON.stringify({ error: 'newPassword is required for resetPassword action.' }) };
                }
                await admin.auth().updateUser(uid, { password: data.newPassword });
                message = `Password reset successfully for user ${uid}.`;
                break;

            default:
                return { statusCode: 400, body: JSON.stringify({ error: 'Invalid action specified.' }) };
        }
        
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: message }),
        };

    } catch (error) {
        console.error(`Error performing user action (${action}):`, error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: `Failed to perform ${action}`, details: error.message }),
        };
    }
};
