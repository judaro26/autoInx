const admin = require('firebase-admin');

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

function ipInSubnet(ip, subnet) {
    if (!subnet || !ip) return false;
    const cleanSubnet = subnet.trim();
    if (!cleanSubnet.includes('/')) return ip.trim() === cleanSubnet;
    
    try {
        const [range, bits] = cleanSubnet.split('/');
        const mask = ~(Math.pow(2, 32 - parseInt(bits)) - 1);
        const ipInt = ip.split('.').reduce((a, b) => (a << 8) + parseInt(b), 0) >>> 0;
        const rangeInt = range.split('.').reduce((a, b) => (a << 8) + parseInt(b), 0) >>> 0;
        return (ipInt & mask) === (rangeInt & mask);
    } catch (e) {
        return false;
    }
}

exports.handler = async function (event) {
    try {
        const clientIp = event.headers['x-nf-client-connection-ip'] || event.headers['client-ip'] || "";
        
        // Fetch config once from Firestore
        const configDoc = await db.doc('admin/config').get();
        const configData = configDoc.exists ? configDoc.data() : {};
        
        // Use the Firestore-based whitelist exclusively
        const whitelist = Array.isArray(configData.ipWhitelist) ? configData.ipWhitelist : [];

        const isWhitelisted = whitelist.some(range => ipInSubnet(clientIp, range));

        return {
            statusCode: 200,
            headers: { 
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache'
            },
            body: JSON.stringify({
                maintenanceMode: configData.maintenanceMode === true,
                chatWidgetEnabled: configData.chatWidgetEnabled !== false,
                isRequesterAdmin: isWhitelisted, 
                clientIp: clientIp 
            }),
        };

    } catch (error) {
        console.error('getPublicConfig Error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Internal Server Error' }),
        };
    }
};
