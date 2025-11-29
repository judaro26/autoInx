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
    const manualMode = event.queryStringParameters?.mode; // 'on' or 'off'
    
    let chatWidgetEnabled;
    let action;

    // --- 1. SECURITY CHECK (ONLY for Manual Overrides) ---
    if (manualMode) {
        const authHeader = event.headers.authorization;
        
        // Ensure a valid token is provided with the manual override
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return { statusCode: 401, body: JSON.stringify({ error: 'Authorization token required for manual override.' }) };
        }
        
        const idToken = authHeader.split('Bearer ')[1];
        try {
            const decodedToken = await admin.auth().verifyIdToken(idToken);
            if (decodedToken.admin !== true) {
                return { statusCode: 403, body: JSON.stringify({ error: 'Access denied: Admin privileges required.' }) };
            }
        } catch (e) {
            console.error('Token verification failed during manual override:', e.message);
            return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired token.' }) };
        }
        
        // If JWT is valid, proceed with manual action logic
        chatWidgetEnabled = manualMode === 'on';
        action = `Manually set to ${chatWidgetEnabled ? 'ON' : 'OFF'} by Admin ${decodedToken.email}`;

    } 
    // --- 2. CRON JOB LOGIC (Runs if not a manual override) ---
    else if (currentUTCHour === 13) {
        chatWidgetEnabled = true;
        action = 'Enabled Chat Widget (Scheduled ON @ 8 AM UTC-5)';
    } else if (currentUTCHour === 1) {
        chatWidgetEnabled = false;
        action = 'Disabled Chat Widget (Scheduled OFF @ 8 PM UTC-5)';
    } else {
        // Safety check for calls outside of target cron hours
        return { statusCode: 200, body: 'Schedule executed outside of target hours (1h or 13h UTC).' };
    }

    // --- 3. DATABASE UPDATE ---
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
        console.error('CRON/Manual Error updating chat widget configuration:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to update chat widget visibility.' })
        };
    }
};
