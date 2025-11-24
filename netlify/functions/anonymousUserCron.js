/**
 * Netlify Function (Scheduled/Cron) to clear ALL anonymous user records from Firebase Auth.
 * This version iterates through all batches internally until cleanup is complete.
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
    let totalDeleted = 0;
    let pageToken = undefined;
    const BATCH_SIZE = 1000;

    try {
        console.log('Starting scheduled anonymous user cleanup job...');

        // Loop until there is no next page token
        do {
            // 1. List users in batches
            const listUsersResult = await admin.auth().listUsers(BATCH_SIZE, pageToken);
            
            // 2. Filter for anonymous users (users with no linked providers)
            const anonymousUids = listUsersResult.users
                .filter(user => user.providerData.length === 0)
                .map(user => user.uid);

            if (anonymousUids.length > 0) {
                // 3. Delete the found anonymous users
                const deleteResult = await admin.auth().deleteUsers(anonymousUids);
                
                if (deleteResult.errors.length > 0) {
                    console.error('Errors deleting anonymous users:', deleteResult.errors);
                }
                
                const deletedInBatch = anonymousUids.length - deleteResult.errors.length;
                totalDeleted += deletedInBatch;
                console.log(`Deleted ${deletedInBatch} anonymous users in this batch.`);
            }
            
            // 4. Set the token for the next page
            pageToken = listUsersResult.pageToken;

        } while (pageToken);


        console.log(`Scheduled cleanup complete. Total deleted: ${totalDeleted}`);
        return {
            statusCode: 200,
            body: JSON.stringify({ message: `Cleanup complete. Total deleted: ${totalDeleted} anonymous users.`, totalDeleted: totalDeleted }),
        };

    } catch (error) {
        console.error('CRON Error clearing anonymous users:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to complete cleanup job', details: error.message }),
        };
    }
};
