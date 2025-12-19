/**
 * Netlify Function (CRON/Admin Manual) to update chat widget visibility.
 * Fixed: Resolved Intl.DateTimeFormat RangeError for weekday.
 */
const admin = require('firebase-admin');

if (!admin.apps.length) {
    const privateKeyString = process.env.FIREBASE_PRIVATE_KEY;
    const cleanedPrivateKey = privateKeyString ? privateKeyString.replace(/\\n/g, '\n').trim() : undefined;

    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: cleanedPrivateKey,
        }),
    });
}

const db = admin.firestore();
const CONFIG_DOC_REF = db.doc('admin/config');

exports.handler = async function(event, context) {
    const manualMode = event.queryStringParameters?.mode;
    let chatWidgetEnabled;
    let action;

    if (manualMode) {
        // --- Security Check ---
        const authHeader = event.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return { statusCode: 401, body: JSON.stringify({ error: 'Auth required' }) };
        }
        const idToken = authHeader.split('Bearer ')[1];
        try {
            const decodedToken = await admin.auth().verifyIdToken(idToken);
            if (decodedToken.admin !== true) throw new Error('Not Admin');
            
            chatWidgetEnabled = manualMode === 'on';
            action = `Manual: ${chatWidgetEnabled ? 'ON' : 'OFF'} by ${decodedToken.email}`;
        } catch (e) {
            return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden' }) };
        }
    } else {
        // --- CRON Logic ---
        const configDoc = await CONFIG_DOC_REF.get();
        const config = configDoc.exists ? configDoc.data() : {};
        const schedule = config.chatSchedule || { enableTime: '08:00', disableTime: '20:00', activeDays: [1,2,3,4,5] };

        // Safe Timezone Calculation (America/Bogota)
        const now = new Date();
        const fmt = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/Bogota',
            hour12: false,
            weekday: 'long', // Use 'long' then map to number
            hour: '2-digit',
            minute: '2-digit'
        });

        const parts = fmt.formatToParts(now).reduce((acc, part) => {
            acc[part.type] = part.value;
            return acc;
        }, {});

        // Map Weekday to 0-6 (Sun-Sat)
        const daysMap = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
        const currentDay = daysMap[parts.weekday];
        const currentTimeStr = `${parts.hour}${parts.minute}`;
        
        const enableTimeStr = schedule.enableTime.replace(':', '');
        const disableTimeStr = schedule.disableTime.replace(':', '');
        const activeDayValues = schedule.activeDays.map(d => parseInt(d) === 7 ? 0 : parseInt(d));

        const isDayActive = activeDayValues.includes(currentDay);
        chatWidgetEnabled = isDayActive && currentTimeStr >= enableTimeStr && currentTimeStr < disableTimeStr;
        action = `Scheduled ${chatWidgetEnabled ? 'ON' : 'OFF'} (Bogota: ${parts.weekday} ${parts.hour}:${parts.minute})`;
    }

    await CONFIG_DOC_REF.update({
        chatWidgetEnabled,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
        lastUpdateAction: action 
    });

    return { statusCode: 200, body: JSON.stringify({ status: 'success', message: action }) };
};
