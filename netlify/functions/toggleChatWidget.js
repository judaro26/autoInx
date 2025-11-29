const admin = require('firebase-admin');

// Ensure Firebase Admin is initialized once using explicit credentials
if (!admin.apps.length) {
    const privateKeyString = process.env.FIREBASE_PRIVATE_KEY;
    let cleanedPrivateKey = undefined;

    if (privateKeyString) {
        // Handle escaped newlines from environment variables
        cleanedPrivateKey = privateKeyString.replace(/\\n/g, '\n').trim();
    }

    try {
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                // Use the cleaned private key
                privateKey: cleanedPrivateKey,
            }),
        });
    } catch (e) {
        console.error("Firebase Admin initialization failed in cron job:", e);
    }
}

const db = admin.firestore();

// FIX: Path to your configuration document must be 'admin/config'
const CONFIG_DOC_REF = db.doc('admin/config');

exports.handler = async function(event, context) {
    
    // Get the current hour in UTC. 
    // This function will be scheduled to run at 01:00 UTC and 13:00 UTC.
    const currentUTCHour = new Date().getUTCHours();
    
    let chatWidgetEnabled;
    let action;

    // Check UTC hour to match Colombia time (UTC-5):
    if (currentUTCHour === 13) {
        // 13:00 UTC = 8:00 AM UTC-5 (Colombia Time) -> ENABLE
        chatWidgetEnabled = true;
        action = 'Enabled Chat Widget (Scheduled ON @ 8 AM UTC-5)';
    } else if (currentUTCHour === 1) {
        // 01:00 UTC = 8:00 PM UTC-5 (Colombia Time) the previous day -> DISABLE
        chatWidgetEnabled = false;
        action = 'Disabled Chat Widget (Scheduled OFF @ 8 PM UTC-5)';
    } else {
        // Safety check if deployed correctly but tested manually
        return { statusCode: 200, body: 'Schedule executed outside of target hours (1h or 13h UTC).' };
    }

    try {
        // Use .update() to modify the existing document
        await CONFIG_DOC_REF.update({
            chatWidgetEnabled: chatWidgetEnabled,
            lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
            lastUpdateAction: action 
        });

        console.log(`${action}: Chat widget set to ${chatWidgetEnabled}.`);

        return {
            statusCode: 200,
            body: JSON.stringify({ status: 'success', message: action })
        };
    } catch (error) {
        // The "No results found for query" log should be replaced by a proper error log if it fails.
        console.error('CRON Error updating chat widget configuration (Check path and permissions):', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to update chat widget visibility.' })
        };
    }
};
