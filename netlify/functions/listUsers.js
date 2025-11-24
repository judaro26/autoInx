/**
 * Netlify Function (Admin Only) to fetch a list of users from Firebase Auth.
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
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    try {
        const { nextPageToken, maxResults = 100 } = event.queryStringParameters || {};

        // Use Admin SDK to list users (limited to 100 per call for pagination)
        const userRecords = await admin.auth().listUsers(parseInt(maxResults), nextPageToken);

        const users = userRecords.users.map(user => ({
            uid: user.uid,
            email: user.email,
            displayName: user.displayName || 'N/A',
            emailVerified: user.emailVerified,
            createdAt: user.metadata.creationTime,
            lastSignInTime: user.metadata.lastSignInTime,
            disabled: user.disabled,
        }));

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                users: users,
                nextPageToken: userRecords.pageToken,
            }),
        };

    } catch (error) {
        console.error('Error listing Firebase users:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to fetch user list', details: error.message }),
        };
    }
};
