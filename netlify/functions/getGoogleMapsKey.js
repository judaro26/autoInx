// netlify/functions/getGoogleMapsKey.js
/**
 * Securely expose the Google Maps JavaScript API key to the frontend
 * while keeping it hidden from Git and public view.
 * 
 * This is the recommended pattern for any third-party API keys that must be used client-side.
 */
exports.handler = async (event, context) => {
  // Optional: Add basic security – only allow requests from your own site
  const origin = event.headers.origin || event.headers.referer || '';
  const allowedOrigins = [
    'https://autoinx.netlify.app',
    'http://localhost:8888',        // Netlify dev
    'http://localhost:3000',        // Vite/React dev (adjust as needed)
  ];

  const isDev = process.env.NETLIFY_DEV || process.env.CONTEXT === 'dev';
  const isAllowed = isDev || allowedOrigins.some(allowed => origin.startsWith(allowed));

  if (!isAllowed && !isDev) {
    console.warn('Unauthorized request to getGoogleMapsKey from:', origin);
    return {
      statusCode: 403,
      body: JSON.stringify({ error: 'Forbidden' })
    };
  }

  try {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY?.trim();

    if (!apiKey) {
      console.error('GOOGLE_MAPS_API_KEY is missing or empty');
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          error: 'Google Maps API key not configured on server' 
        })
      };
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=86400, immutable', // Cache for 24h
        'Access-Control-Allow-Origin': isDev ? '*' : 'https://autoinx.netlify.app',
      },
      body: JSON.stringify({ apiKey })
    };

  } catch (error) {
    console.error('Unexpected error in getGoogleMapsKey:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};
