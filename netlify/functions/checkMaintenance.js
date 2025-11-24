/**
 * Netlify Function to check the Maintenance Mode status from Firestore.
 */
const fetch = require('node-fetch');

// The internal Netlify function URL
const GET_CONFIG_FUNCTION_URL = '/.netlify/functions/getAdminConfig';

exports.handler = async function (event) {
    try {
        // Fetch config using an internal endpoint (assuming Netlify functions can call each other)
        const response = await fetch(`${process.env.URL}${GET_CONFIG_FUNCTION_URL}`);
        
        if (!response.ok) {
            throw new Error('Failed to fetch admin config internally.');
        }

        const config = await response.json();

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ maintenanceMode: config.maintenanceMode || false }),
        };

    } catch (error) {
        console.error('Error checking maintenance mode:', error);
        // Fail-safe: assume maintenance is OFF if the check fails
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ maintenanceMode: false }),
        };
    }
};
