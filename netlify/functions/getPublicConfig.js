const admin = require('firebase-admin');

// Initialize Firebase Admin
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

/**
 * CIDR-aware IP matching
 */
function ipInSubnet(ip, subnet) {
    if (!subnet || !ip) return false;
    
    // Force both to strings and trim whitespace/newlines
    const cleanIp = String(ip).trim();
    const cleanSubnet = String(subnet).trim();

    if (!cleanSubnet.includes('/')) {
        return cleanIp === cleanSubnet;
    }
    
    try {
        const [range, bits] = cleanSubnet.split('/');
        const mask = ~(Math.pow(2, 32 - parseInt(bits)) - 1);
        
        const ipInt = cleanIp.split('.').reduce((a, b) => (a << 8) + parseInt(b), 0) >>> 0;
        const rangeInt = range.split('.').reduce((a, b) => (a << 8) + parseInt(b), 0) >>> 0;
        
        return (ipInt & mask) === (rangeInt & mask);
    } catch (e) {
        console.error("Subnet calculation error:", e);
        return false;
    }
}

exports.handler = async function (event) {
    try {
        // Get IP from Netlify headers
        const clientIp = event.headers['x-nf-client-connection-ip'] || event.headers['client-ip'] || "";
        
        // 1. Fetch Dynamic Config from Firestore document: admin/config
        const configDoc = await db.doc('admin/config').get();
        const configData = configDoc.exists ? configDoc.data() : {};
        
        // 2. Extract Whitelist from Firestore array
        const whitelist = Array.isArray(configData.ipWhitelist) ? configData.ipWhitelist : [];

        // 3. Match current IP against the list
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

     const whitelist = Array.isArray(configData.ipWhitelist) ? configData.ipWhitelist : [];
    
    // ADD THESE LOGS:
    console.log("Checking IP:", `[${clientIp}]`); // Brackets help see hidden spaces
    console.log("Against Whitelist:", whitelist);
    
    const isWhitelisted = whitelist.some(range => {
        const match = ipInSubnet(clientIp, range);
        console.log(`Comparing ${clientIp} to ${range}: Result ${match}`);
        return match;
    });   
    
};
