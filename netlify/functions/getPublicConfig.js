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
 * CIDR-aware IP matching with aggressive trimming
 */
function ipInSubnet(ip, subnet) {
    if (!subnet || !ip) return false;
    
    // Force to strings and strip all whitespace/hidden characters
    const cleanIp = String(ip).replace(/\s/g, '');
    const cleanSubnet = String(subnet).replace(/\s/g, '');

    // 1. Direct Match Check
    if (cleanIp === cleanSubnet) return true;

    // 2. Subnet Range Check
    if (cleanSubnet.includes('/')) {
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
    return false;
}

exports.handler = async function (event) {
    try {
        // Capture User IP from Netlify headers
        const clientIp = event.headers['client-ip'] || 
                         (event.headers['x-forwarded-for'] || "").split(',')[0].trim() ||
                         event.headers['x-nf-client-connection-ip'] || 
                         "";

        // Fetch Dynamic Config from Firestore
        const configDoc = await db.doc('admin/config').get();
        const configData = configDoc.exists ? configDoc.data() : {};
        
        const whitelist = Array.isArray(configData.ipWhitelist) ? configData.ipWhitelist : [];

        // --- DEBUG LOGGING ---
        console.log("--- DEBUG START ---");
        console.log("Raw Client IP Header:", clientIp);
        console.log("Cleaned Client IP:", clientIp.trim());
        console.log("Firestore Whitelist:", JSON.stringify(whitelist));
        
        const isWhitelisted = whitelist.some(range => {
            const match = ipInSubnet(clientIp, range);
            console.log(`Comparing [${clientIp.trim()}] to [${String(range).trim()}] -> Match: ${match}`);
            return match;
        });
        console.log("Final Authorization Result:", isWhitelisted);
        console.log("--- DEBUG END ---");

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
                clientIp: clientIp.trim() 
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
