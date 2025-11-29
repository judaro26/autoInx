const admin = require('firebase-admin');

// Ensure Firebase Admin is initialized once using explicit credentials (using the fix from the previous turn)
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
                privateKey: cleanedPrivateKey,
            }),
        });
    } catch (e) {
        console.error("Firebase Admin initialization failed in cron job:", e);
    }
}

const db = admin.firestore();
const CONFIG_DOC_REF = db.doc('admin/config');

exports.handler = async function(event, context) {
    
    const currentUTCHour = new Date().getUTCHours();
    // NEW: Check for manual override parameter
    const manualMode = event.queryStringParameters?.mode; 
    
    let chatWidgetEnabled;
    let action;

    // --- 1. MANUAL OVERRIDE LOGIC ---
    if (manualMode === 'on') {
        chatWidgetEnabled = true;
        action = 'Enabled Chat Widget (MANUAL OVERRIDE)';
    } else if (manualMode === 'off') {
        chatWidgetEnabled = false;
        action = 'Disabled Chat Widget (MANUAL OVERRIDE)';
    } 
    // --- 2. EXISTING CRON LOGIC ---
    else if (currentUTCHour === 13) {
        chatWidgetEnabled = true;
        action = 'Enabled Chat Widget (Scheduled ON @ 8 AM UTC-5)';
    } else if (currentUTCHour === 1) {
        chatWidgetEnabled = false;
        action = 'Disabled Chat Widget (Scheduled OFF @ 8 PM UTC-5)';
    } else {
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
        console.error('CRON Error updating chat widget configuration (Check path and permissions):', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to update chat widget visibility.' })
        };
    }
};
