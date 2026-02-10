const admin = require('firebase-admin');

if (!admin.apps.length) {
    const privateKeyString = process.env.FIREBASE_PRIVATE_KEY;
    let cleanedPrivateKey = undefined;
    if (privateKeyString) {
        cleanedPrivateKey = privateKeyString
            .replace(/\\n/g, '\n')
            .replace(/\n/g, '\n')
            .trim();
    }
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: cleanedPrivateKey,
        }),
    });
}

// ✅ db must be declared HERE at module level, outside the handler
const db = admin.firestore();
const CONFIG_DOC_PATH = 'admin/config';

exports.handler = async function (event) {

    const authHeader = event.headers.authorization;
    let isAdmin = false;

    if (authHeader && authHeader.startsWith('Bearer ')) {
        const idToken = authHeader.split('Bearer ')[1];
        try {
            const decodedToken = await admin.auth().verifyIdToken(idToken);
            isAdmin = decodedToken.admin === true;
        } catch (e) {
            isAdmin = false;
        }
    }

    try {
        const configRef = db.doc(CONFIG_DOC_PATH);
        const configDoc = await configRef.get();

        if (!configDoc.exists) {
            const initialConfig = {
                ipWhitelist: ["127.0.0.1"],
                maintenanceMode: false,
                chatWidgetEnabled: true,
                lastUpdated: admin.firestore.FieldValue.serverTimestamp()
            };
            await configRef.set(initialConfig);

            if (!isAdmin) {
                const { ipWhitelist, ...publicConfig } = initialConfig;
                return {
                    statusCode: 200,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(publicConfig),
                };
            }
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(initialConfig),
            };
        }

        const configData = configDoc.data();
        if (configData.chatWidgetEnabled === undefined) {
            configData.chatWidgetEnabled = true;
        }

        if (!isAdmin) {
            const { ipWhitelist, ...publicConfig } = configData;
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(publicConfig),
            };
        }

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(configData),
        };

    } catch (error) {
        console.error('Error fetching admin config:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to fetch admin configuration', details: error.message }),
        };
    }
};
