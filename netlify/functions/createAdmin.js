/**
 * TEMPORARY NETLIFY FUNCTION: setAdminClaim.js
 * * This function securely sets the custom claim {admin: true} for a specified user UID.
 * This should be deleted or secured immediately after use.
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

    const { uid } = requestBody;
    
    // SECURITY CHECK: Hardcoded UID to ensure only your target user is promoted.
    const ALLOWED_UID = "JDI1nBJeemgtGF373iXjXlFICf82"; 
    if (uid !== ALLOWED_UID) {
        return { statusCode: 403, body: JSON.stringify({ error: 'Unauthorized UID provided' }) };
    }

    try {
        // Set the custom claim {admin: true}
        await admin.auth().setCustomUserClaims(uid, { admin: true });
        
        const user = await admin.auth().getUser(uid);
        
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                message: `SUCCESS: Custom claim {admin: true} set for user ${uid} (${user.email}).`,
                action_required: `The user MUST sign out and sign back in for the new admin status to take effect.`
            }),
        };

    } catch (error) {
        console.error('Error setting custom claim:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to set admin claim', details: error.message, firebase_error_code: error.code }),
        };
    }
};
