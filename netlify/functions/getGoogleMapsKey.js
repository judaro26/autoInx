// autoInx-main/netlify/functions/getGoogleMapsKey.js

/**
 * Netlify Function to securely serve the public Google Maps Platform API key 
 * from the environment variables to the client.
 */
exports.handler = async function(event, context) {
    try {
        // Assume the key is set in Netlify environment variables
        const apiKey = process.env.GOOGLE_MAPS_API_KEY;

        if (!apiKey) {
            console.error("GOOGLE_MAPS_API_KEY environment variable missing.");
            return {
                statusCode: 500,
                body: JSON.stringify({ error: 'Google Maps API Key not configured on the server.' })
            };
        }

        return {
            statusCode: 200,
            headers: { 
                'Content-Type': 'application/json',
                // Important: Cache policy for the API key fetch can be aggressive
                'Cache-Control': 'public, max-age=3600'
            },
            body: JSON.stringify({ apiKey: apiKey })
        };
    } catch (error) {
        console.error('Error fetching Google Maps API key:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to fetch Maps API key' })
        };
    }
};
