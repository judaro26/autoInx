/**
 * Netlify Function (Admin Only) to clear anonymous user records from Firebase Auth.
 * Filters for users with no linked provider data (i.e., anonymous users) and deletes them in batches.
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

// Helper to list, filter, and delete anonymous users in a batch-safe manner
async function processAnonymousBatch(nextPageToken) {
    let pageToken = nextPageToken;
    let usersToDelete = [];
    const BATCH_SIZE = 1000;

    // List users in batches of 1000 until we find enough to delete or reach the end.
    const listUsersResult = await admin.auth().listUsers(BATCH_SIZE, pageToken);
    
    // Filter for anonymous users (users with no linked providers)
    const anonymousUids = listUsersResult.users
        .filter(user => user.providerData.length === 0)
        .map(user => user.uid);

    if (anonymousUids.length > 0) {
        // Delete the found anonymous users
        const deleteResult = await admin.auth().deleteUsers(anonymousUids);
        
        if (deleteResult.errors.length > 0) {
            console.error('Errors deleting anonymous users:', deleteResult.errors);
        }
        
        const totalDeleted = anonymousUids.length - deleteResult.errors.length;
        
        return {
            deletedCount: totalDeleted,
            nextPageToken: listUsersResult.pageToken // The token to continue listing from
        };
    }
    
    // If no anonymous users found in this batch, still return the pageToken to check the next page
    return {
        deletedCount: 0,
        nextPageToken: listUsersResult.pageToken
    };
}


exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed, only POST is allowed' }) };
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
        const { nextPageToken } = JSON.parse(event.body);
        
        const result = await processAnonymousBatch(nextPageToken);

        // If there are more pages, return 202 (Accepted for processing) to signal continuation
        if (result.nextPageToken) {
             return {
                statusCode: 202,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    message: `${result.deletedCount} anonymous users deleted. More batches remain.`,
                    nextPageToken: result.nextPageToken,
                    deletedCount: result.deletedCount
                }),
            };
        }

        // Final result: 200 OK
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                message: `${result.deletedCount} anonymous users deleted. Cleanup complete.`,
                nextPageToken: null,
                deletedCount: result.deletedCount
            }),
        };

    } catch (error) {
        console.error('Error clearing anonymous users:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to clear anonymous users', details: error.message }),
        };
    }
};
