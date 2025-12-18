const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// ... (Firebase initialization code remains the same) ...

// NEW HELPER: Checks if an IP address belongs to a CIDR subnet
function ipInSubnet(ip, subnet) {
    if (!subnet.includes('/')) return ip === subnet;
    
    try {
        const [range, bits] = subnet.split('/');
        const mask = ~(Math.pow(2, 32 - parseInt(bits)) - 1);
        
        const ipInt = ip.split('.').reduce((a, b) => (a << 8) + parseInt(b), 0) >>> 0;
        const rangeInt = range.split('.').reduce((a, b) => (a << 8) + parseInt(b), 0) >>> 0;
        
        return (ipInt & mask) === (rangeInt & mask);
    } catch (e) {
        return false;
    }
}

function getHardcodedWhitelist() {
    try {
        const filePath = path.resolve(__dirname, '../../js/utilities/ipWhitelist.js');
        const fileContent = fs.readFileSync(filePath, 'utf8');
        
        // Flexible Regex to catch single quotes, double quotes, and ranges
        const ipRegex = /['"]\s*(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?:\/\d{1,2})?)\s*['"]/g;
        const matches = [];
        let match;
        while ((match = ipRegex.exec(fileContent)) !== null) {
            matches.push(match[1]);
        }
        return matches;
    } catch (err) {
        console.error("Whitelist read error:", err);
        return [];
    }
}

exports.handler = async function (event) {
    try {
        const clientIp = event.headers['x-nf-client-connection-ip'] || event.headers['client-ip'] || "";
        const staticWhitelist = getHardcodedWhitelist();

        const configDoc = await db.doc('admin/config').get();
        const configData = configDoc.exists ? configDoc.data() : {};
        const dynamicWhitelist = Array.isArray(configData.ipWhitelist) ? configData.ipWhitelist : [];

        // REVISED CHECK: Uses the CIDR helper for both lists
        const isWhitelisted = 
            dynamicWhitelist.some(range => ipInSubnet(clientIp, range)) || 
            staticWhitelist.some(range => ipInSubnet(clientIp, range));

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                maintenanceMode: configData.maintenanceMode === true,
                chatWidgetEnabled: configData.chatWidgetEnabled !== false,
                isRequesterAdmin: isWhitelisted, // This will now be TRUE for your IP
                clientIp: clientIp
            }),
        };
    } catch (error) {
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
