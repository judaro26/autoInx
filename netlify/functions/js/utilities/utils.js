import { ipWhitelist } from './ipWhitelist.js';

// NOTE: Since direct file access to update ipWhitelist.js is complex in Netlify,
// we are moving to fetching the IP whitelist from a Netlify function (Firestore-backed)
const GET_CONFIG_FUNCTION_URL = '/.netlify/functions/getAdminConfig';


/**
 * Checks the user's public IP address against the dynamic whitelist stored in Firestore.
 * @returns {Promise<boolean>} True if the IP is whitelisted, false otherwise.
 */
export async function checkIPRange() {
    let ipWhitelist = [];
    
    try {
        // 1. Fetch IP Whitelist from the dedicated Netlify function (which reads Firestore)
        const configResponse = await fetch(`${window.location.origin}${GET_CONFIG_FUNCTION_URL}`);
        
        if (!configResponse.ok) {
            console.error('Failed to fetch admin config for IP check.');
            // Fall back to a local default if config API fails
            ipWhitelist = ["127.0.0.1"];
        } else {
            const configData = await configResponse.json();
            ipWhitelist = configData.ipWhitelist || [];
        }

        // 2. Get User IP
        const response = await fetch('https://api.ipify.org?format=json');
        
        if (!response.ok) {
            console.error('Failed to fetch user IP address. Returning false for security.');
            return false;
        }

        const data = await response.json();
        const userIP = data.ip;

        // 3. Check against the dynamic whitelist array
        const isWhitelisted = ipWhitelist.includes(userIP);
        
        console.log(`User IP: ${userIP}, Whitelisted: ${isWhitelisted}`);
        
        return isWhitelisted;

    } catch (error) {
        console.error('Error during IP address check:', error);
        // Fail safe: return false on any error.
        return false;
    }
}
