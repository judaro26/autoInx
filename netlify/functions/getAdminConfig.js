/**
 * Netlify Function to get or initialize Admin configuration from Firestore.
 * This includes the dynamic IP Whitelist and Maintenance Mode status.
 */
const admin = require('firebase-admin');

// Ensure Firebase Admin is initialized once
if (!admin.apps.length) {
    // FIX: Reverting the Netlify variable value to single-backslash required a code adjustment.
    // This logic handles the possibility of either '\n' or '\\n' being the delimiter.
    
    const privateKeyString = process.env.FIREBASE_PRIVATE_KEY;
    let cleanedPrivateKey = undefined;

    if (privateKeyString) {
        // Step 1: Replace all instances of single-backslash-n (\n) or double-backslash-n (\\n) 
        // with the literal newline character (\n).
        // The regex /\n/g targets the literal string "\n" passed from the environment (where the \ is already escaped by Node).
        // Since we are reverting the environment variable to the single-backslash version, this should now work.
        cleanedPrivateKey = privateKeyString
                                .replace(/\\n/g, '\n') // Handles the case if Netlify auto-escapes or we used \\n
                                .replace(/\n/g, '\n') // Handles the simple \n case, ensuring it's a newline
                                .trim(); // Remove any leading/trailing whitespace that invalidates PEM

    }

    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            // Use the cleaned private key
            privateKey: cleanedPrivateKey,
        }),
    });
}

const db = admin.firestore();
// Path: Collection 'admin', Document 'config'
const CONFIG_DOC_PATH = 'admin/config';

exports.handler = async function (event) {
    try {
        const configRef = db.doc(CONFIG_DOC_PATH);
        const configDoc = await configRef.get();

        if (!configDoc.exists) {
            // Initialize config if it doesn't exist
            const initialConfig = {
                ipWhitelist: ["127.0.0.1"], // Default IP
                maintenanceMode: false,
                chatWidgetEnabled: true, // Ensuring this field is present in the initial config
                lastUpdated: admin.firestore.FieldValue.serverTimestamp()
            };
            await configRef.set(initialConfig);
            console.log('Admin config initialized.');
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(initialConfig),
            };
        }
        
        // Ensure new fields are added if missing from old config (chatWidgetEnabled added here)
        const configData = configDoc.data();
        if (configData.chatWidgetEnabled === undefined) {
             configData.chatWidgetEnabled = true;
             // NOTE: We do NOT write this update back to Firestore in the fetch function, 
             // we just use the updated data structure on the fly.

        }

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(configData),
        };

    } catch (error) {
        console.error('Error fetching admin config:', error);
        // This log will only show if the error happened AFTER successful initialization.
        return {
            statusCode: 500, // Return 500 on server error
            body: JSON.stringify({ error: 'Failed to fetch admin configuration', details: error.message }),
        };
    }
};
