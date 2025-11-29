/**
 * Netlify Function (CRON/Admin Manual) to update the chat widget visibility based on a dynamic schedule.
 * Runs hourly via cron.
 */
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
    
    const manualMode = event.queryStringParameters?.mode; // 'on' or 'off'
    let chatWidgetEnabled;
    let action;

    // --- 1. Security Check & Handle Manual Override ---
    if (manualMode) {
        const authHeader = event.headers.authorization;
        
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
        
        chatWidgetEnabled = manualMode === 'on';
        action = `Manually set to ${chatWidgetEnabled ? 'ON' : 'OFF'} by Admin ${decodedToken.email}`;

    } 
    // --- 2. CRON JOB LOGIC (Dynamic Schedule) ---
    else {
        // A. Fetch the latest configuration from Firestore
        let configDoc;
        try {
            configDoc = await CONFIG_DOC_REF.get();
        } catch (error) {
            console.error('Error fetching config for CRON job:', error);
            return { statusCode: 500, body: JSON.stringify({ error: 'Failed to fetch schedule config.' }) };
        }

        const config = configDoc.exists ? configDoc.data() : {};
        const schedule = config.chatSchedule;

        // Check for existing manual override on the general toggle
        if (config.chatWidgetEnabled === false) {
             console.log("Skipping scheduled change: Chat is manually disabled by Admin toggle.");
             return { statusCode: 200, body: 'Skipping scheduled change: Manual global disable detected.' };
        }

        const defaultSchedule = { enableTime: '08:00', disableTime: '20:00', activeDays: [1, 2, 3, 4, 5] };
        const finalSchedule = schedule || defaultSchedule;
        
        if (!finalSchedule.enableTime || !finalSchedule.disableTime || !finalSchedule.activeDays || finalSchedule.activeDays.length === 0) {
            console.warn("Dynamic chat schedule is incomplete or missing. Defaulting to OFF.");
            chatWidgetEnabled = false;
            action = 'Disabled Chat Widget (Missing Schedule)';
        } else {
            // B. Determine current time and day in UTC-5 (Colombia Time)
            const DATE_OPTIONS = { 
                timeZone: 'America/Bogota', 
                weekday: 'numeric', // 1 (Mon) - 7 (Sun)
                hour: '2-digit', 
                minute: '2-digit', 
                hour12: false 
            };
            
            // Get date/time components as strings in Bogota timezone
            const bogotaDate = new Date().toLocaleDateString('en-US', DATE_OPTIONS); 
            const [dayStr, timeStr] = bogotaDate.split(', ')[1].split(' '); 
            
            const currentDay = parseInt(dayStr); // Day of week (1=Mon, 7=Sun, where 7 must be converted to 0)
            const currentTimeStr = timeStr.replace(':', ''); // HHMM format
            const enableTimeStr = finalSchedule.enableTime.replace(':', ''); 
            const disableTimeStr = finalSchedule.disableTime.replace(':', ''); 

            // Convert 7 (Sunday) to 0 for consistency with the checkbox values
            const activeDayValues = finalSchedule.activeDays.map(d => parseInt(d) === 7 ? 0 : parseInt(d));
            const isDayActive = activeDayValues.includes(currentDay === 7 ? 0 : currentDay);
            
            // C. Determine state based on schedule
            if (isDayActive && currentTimeStr >= enableTimeStr && currentTimeStr < disableTimeStr) {
                chatWidgetEnabled = true;
                action = `Enabled Chat Widget (Scheduled ON ${finalSchedule.enableTime} UTC-5 on Day ${currentDay})`;
            } else {
                chatWidgetEnabled = false;
                action = `Disabled Chat Widget (Scheduled OFF)`;
            }
        }
    }
    
    // --- 3. DATABASE UPDATE (Unified update logic) ---
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
