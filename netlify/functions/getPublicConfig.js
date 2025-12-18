const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

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
 * Helper: Checks if an IP address belongs to a CIDR subnet
 * Works for exact IPs (1.2.3.4) and ranges (1.2.3.0/24)
 */
function ipInSubnet(ip, subnet) {
    if (!subnet || !ip) return false;
    if (!subnet.includes('/')) return ip === subnet.trim();
    
    try {
        const [range, bits] = subnet.split('/');
        const mask = ~(Math.pow(2, 32 - parseInt(bits)) - 1);
        
        const ipInt = ip.split('.').reduce((a, b) => (a << 8) + parseInt(b), 0) >>> 0;
        const rangeInt = range.split('.').reduce((a, b) => (a << 8) + parseInt(b), 0) >>> 0;
        
        return (ipInt & mask) === (rangeInt & mask);
    } catch (e) {
        console.error("Error calculating subnet match:", e);
        return false;
    }
}

/**
 * Reads your existing frontend utility file as text and extracts IPs/Ranges
 */
function getHardcodedWhitelist() {
    try {
        // Path should point to your web folder's utility file
        const filePath = path.resolve(__dirname, '../../js/utilities/ipWhitelist.js');
        const fileContent = fs.readFileSync(filePath, 'utf8');
        
        // Regex to find IPs or CIDR ranges inside quotes
        const ipRegex = /['"]\s*(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?:\/\d{1,2})?)\s*['"]/g;
        const matches = [];
        let match;
        while ((match = ipRegex.exec(fileContent)) !== null) {
            matches.push(match[1]);
        }
        return matches;
    } catch (err) {
        console.error("Could not read ipWhitelist.js file:", err);
        return [];
    }
}

exports.handler = async function (event) {
    try {
        // Detect Client IP from Netlify headers
        const clientIp = event.headers['x-nf-client-connection-ip'] || event.headers['client-ip'] || "";
        
        // 1. Load lists
        const staticWhitelist = getHardcodedWhitelist();
        const configDoc = await db.doc('admin/config').get();
        const configData = configDoc.exists ? configDoc.data() : {};
        const dynamicWhitelist = Array.isArray(configData.ipWhitelist) ? configData.ipWhitelist : [];

        // 2. Perform CIDR-aware check
        const isWhitelisted = 
            dynamicWhitelist.some(range => ipInSubnet(clientIp, range)) || 
            staticWhitelist.some(range => ipInSubnet(clientIp, range));

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
