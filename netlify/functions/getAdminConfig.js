/**
 * Netlify Function to get or initialize Admin configuration from Firestore.
 * This includes the dynamic IP Whitelist and Maintenance Mode status.
 */
const admin = require('firebase-admin');

// Ensure Firebase Admin is initialized once
if (!admin.apps.length) {
    // START FIX: Aggressively clean the private key string to ensure correct PEM formatting.
    const privateKeyString = process.env.FIREBASE_PRIVATE_KEY;
    let cleanedPrivateKey = undefined;

    if (privateKeyString) {
        // Step 1: Replace all known/possible escaped newline sequences (\\n or \n) with a real newline (\n)
        // We use a global regex replacement here, which is safer than relying on single backslashes in Netlify.
        // The regex /\\n/g targets the literal two-character string '\n' used for escaping.
        cleanedPrivateKey = privateKeyString.replace(/\\n/g, '\n');
        
        // Final sanity check: if the key contains no newlines at all, it's definitely corrupted.
        if (!cleanedPrivateKey.includes('\n') && cleanedPrivateKey.includes('PRIVATE KEY')) {
             console.error("Warning: Private key cleaning failed to create newlines.");
             // Fallback for environments that pass the literal unescaped string
             // In some cases, Node may receive a key that is already unescaped but compressed.
             // We'll rely on the aggressive replacement above, but this remains the most likely failure point.
        }
    }
    // END FIX

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
                chatWidgetEnabled: true, 
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
        
        // Ensure old configs have the new field (default to true)
        const configData = configDoc.data();
        if (configData.chatWidgetEnabled === undefined) {
            configData.chatWidgetEnabled = true;
        }

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(configData),
        };

    } catch (error) {
        console.error('Error fetching admin config:', error);
        // This log will only show if the error happened AFTER initialization.
        return {
            statusCode: 500, // Return 500 on server error
            body: JSON.stringify({ error: 'Failed to fetch admin configuration', details: error.message }),
        };
    }
};
