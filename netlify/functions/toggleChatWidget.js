const admin = require('firebase-admin');

// Initialize Firebase Admin SDK (must be done outside the handler)
// Netlify uses FIREBASE_SERVICE_ACCOUNT_KEY env var for authentication.
if (!admin.apps.length) {
    try {
        admin.initializeApp({
            credential: admin.credential.applicationDefault()
        });
    } catch (e) {
        console.error("Firebase Admin initialization failed:", e);
    }
}
const db = admin.firestore();

// Path to your configuration document (adjust 'config/admin' if needed)
const CONFIG_DOC_REF = db.doc('config/admin');

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
        console.error('Error updating chat widget configuration:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to update chat widget visibility.' })
        };
    }
};
