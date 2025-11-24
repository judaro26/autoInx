// autoInx-main/netlify/functions/js/utilities/utils.js

const { ipWhitelist } = require('./ipWhitelist.js');

/**
 * Checks the user's public IP address against the predefined whitelist
 * exported from ./ipWhitelist.js.
 * @returns {Promise<boolean>} True if the IP is whitelisted, false otherwise.
 */
exports.checkIPRange = async function () {
    try {
        const response = await fetch('https://api.ipify.org?format=json');
        
        if (!response.ok) {
            console.error('Failed to fetch user IP address. Returning false for security.');
            // Fail safe: if we can't check the IP, assume it's not whitelisted.
            return false;
        }

        const data = await response.json();
        const userIP = data.ip;

        // Check against the imported static whitelist array
        const isWhitelisted = ipWhitelist.includes(userIP);
        
        console.log(`User IP: ${userIP}, Whitelisted: ${isWhitelisted}`);
        
        return isWhitelisted;

    } catch (error) {
        console.error('Error during IP address check:', error);
        // Fail safe: return false on any error.
        return false;
    }
}
