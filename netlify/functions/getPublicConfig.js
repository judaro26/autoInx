const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// --- FIREBASE INIT (Same as before) ---
if (!admin.apps.length) {
    const privateKeyString = process.env.FIREBASE_PRIVATE_KEY;
    let cleanedPrivateKey = privateKeyString ? privateKeyString.replace(/\\n/g, '\n').trim() : undefined;
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: cleanedPrivateKey,
        }),
    });
}

const db = admin.firestore();

// --- SECURE IP EXTRACTION ---
// We read your existing file as text to avoid "Export/Require" format conflicts
function getHardcodedWhitelist() {
    try {
        // Adjust the path to where your frontend ipWhitelist.js is located relative to this function
        const filePath = path.resolve(__dirname, '../../js/utilities/ipWhitelist.js');
        const fileContent = fs.readFileSync(filePath, 'utf8');
        
        // This regex finds strings inside the brackets of your ipWhitelist array
        const ipRegex = /'(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?:\/\d{1,2})?)'/g;
        const matches = [];
        let match;
        while ((match = ipRegex.exec(fileContent)) !== null) {
            matches.push(match[1]);
        }
        return matches;
    } catch (err) {
        console.error("Could not read hardcoded whitelist file:", err);
        return [];
    }
}

exports.handler = async function (event) {
    try {
        const clientIp = event.headers['x-nf-client-connection-ip'] || event.headers['client-ip'] || "";
        
        // 1. Get the list from your existing frontend file (processed on server)
        const staticWhitelist = getHardcodedWhitelist();

        // 2. Get the dynamic list from Firestore
        const configDoc = await db.doc('admin/config').get();
        const configData = configDoc.exists ? configDoc.data() : {};
        const dynamicWhitelist = Array.isArray(configData.ipWhitelist) ? configData.ipWhitelist : [];

        // 3. Perform the check
        const isWhitelisted = dynamicWhitelist.includes(clientIp) || staticWhitelist.includes(clientIp);

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                maintenanceMode: configData.maintenanceMode === true,
                chatWidgetEnabled: configData.chatWidgetEnabled !== false,
                isRequesterAdmin: isWhitelisted,
                clientIp: clientIp
            }),
        };
    } catch (error) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Internal Error' }) };
    }
};
