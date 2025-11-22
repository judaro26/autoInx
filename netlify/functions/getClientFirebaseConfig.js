/**
 * Netlify Function to securely serve ONLY the public Firebase client configuration.
 *
 * It explicitly omits the sensitive Firebase Admin credentials (privateKey, clientEmail)
 * which are required for Netlify Functions but must NEVER be sent to the front-end client.
 */
exports.handler = async function(event, context) {
  try {
    // Only include client-safe configuration variables
    const config = {
      apiKey: process.env.FIREBASE_API_KEY,
      authDomain: process.env.FIREBASE_AUTH_DOMAIN,
      projectId: process.env.FIREBASE_PROJECT_ID,
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
      messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
      appId: process.env.FIREBASE_APP_ID,
      databaseURL: process.env.FIREBASE_DATABASE_URL,
    };
    
    // Check if the essential apiKey is present before returning
    if (!config.apiKey || !config.projectId) {
        console.error("Firebase public config environment variables missing.");
        return {
          statusCode: 500,
          body: JSON.stringify({ error: 'Firebase public config not configured.' })
        };
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*' // Allow cross-origin access if needed
      },
      body: JSON.stringify(config)
    };
  } catch (error) {
    console.error('Error fetching Firebase client config:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to fetch Firebase client config' })
    };
  }
};
