const admin = require('firebase-admin');

// Import IP whitelist from shared utilities
const { ipWhitelist: staticIpWhitelist } = require('../../js/utilities/ipWhitelist.js');

// Initialize Firebase Admin (only once)
if (!admin.apps.length) {
    // ✅ Construct service account from individual environment variables
    const serviceAccount = {
        type: "service_account",
        project_id: process.env.FIREBASE_PROJECT_ID,
        private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID || "dummy-key-id",
        private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        client_email: process.env.FIREBASE_CLIENT_EMAIL,
        client_id: process.env.FIREBASE_CLIENT_ID || "dummy-client-id",
        auth_uri: "https://accounts.google.com/o/oauth2/auth",
        token_uri: "https://oauth2.googleapis.com/token",
        auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
        client_x509_cert_url: `https://www.googleapis.com/robot/v1/metadata/x509/${encodeURIComponent(process.env.FIREBASE_CLIENT_EMAIL)}`
    };

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DATABASE_URL
    });
}

const db = admin.firestore();

/**
 * Get client IP from Netlify request headers
 */
function getClientIp(event) {
    return event.headers['x-nf-client-connection-ip'] || 
           event.headers['x-forwarded-for']?.split(',')[0] || 
           event.headers['client-ip'] || 
           'unknown';
}

/**
 * Check if IP is whitelisted (static or dynamic)
 */
async function isIpWhitelisted(clientIp) {
    // Check static whitelist
    if (staticIpWhitelist.includes(clientIp)) {
        return true;
    }

    // Check dynamic whitelist from Firestore
    try {
        // ✅ FIXED PATH: Changed from collection('config').doc('admin')
        const configDoc = await db.collection('admin').doc('config').get();
        
        if (configDoc.exists) {
            const dynamicWhitelist = configDoc.data().ipWhitelist || [];
            console.log('Dynamic whitelist:', dynamicWhitelist); // Debug log
            console.log('Checking IP:', clientIp); // Debug log
            return dynamicWhitelist.includes(clientIp);
        } else {
            console.log('Config document does not exist at admin/config');
        }
    } catch (error) {
        console.error('Error checking dynamic IP whitelist:', error);
    }

    return false;
}

/**
 * Main handler for public configuration
 */
exports.handler = async (event, context) => {
    // CORS headers
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Content-Type': 'application/json'
    };

    // Handle OPTIONS request
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 204, headers, body: '' };
    }

    // Only allow GET requests
    if (event.httpMethod !== 'GET') {
        return {
            statusCode: 405,
            headers,
            body: JSON.stringify({ error: 'Method not allowed' })
        };
    }

    try {
        // Get client IP
        const clientIp = getClientIp(event);
        console.log('Public config request from IP:', clientIp);

        // Check if IP is whitelisted
        const isWhitelisted = await isIpWhitelisted(clientIp);

        // Fetch config from Firestore
        const configRef = db.collection('admin').doc('config');
        const configDoc = await configRef.get();

        let config = {};
        if (configDoc.exists) {
            config = configDoc.data();
        }

        // Build public response
        const publicConfig = {
            // Maintenance mode
            maintenanceMode: config.maintenanceMode || false,
            
            // Chat widget settings
            chatWidgetEnabled: config.chatWidgetEnabled || false,
            chatSchedule: config.chatSchedule || {
                enableTime: '08:00',
                disableTime: '20:00',
                activeDays: [1, 2, 3, 4, 5] // Mon-Fri
            },
            
            // Branding configuration
            branding: config.branding || {
                logoUrl: '/images/AutoInx logo.png',
                headerText: {
                    en: 'Catalog',
                    es: 'Catálogo'
                },
                colors: {
                    backgroundStart: '#f0f9ff',
                    backgroundEnd: '#e0e7ff',
                    addToCart: '#ec4899',
                    checkout: '#ec4899'
                }
            },
            
            // Footer configuration
            footer: config.footer || {
                companyName: 'AutoInx',
                tagline: {
                    en: 'Bringing the world closer',
                    es: 'Acercando el mundo'
                },
                contacts: {
                    supportEmail: 'support@autoinx.com',
                    ordersEmail: 'orders@autoinx.com',
                    phoneUS: '(937) 701-6185',
                    phoneCO: '+57 321 704 0789'
                },
                locations: {
                    colombia: [
                        'Calle 68A 92-24, Bogota DC',
                        'Calle 68A 92-58, Bogota'
                    ],
                    usa: '587 Paradise Blvd, Hayward, CA 94541'
                }
            },
            
            // Admin access info (for frontend logic)
            isRequesterAdmin: isWhitelisted,
            clientIp: clientIp
        };

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify(publicConfig)
        };

    } catch (error) {
        console.error('Error fetching public config:', error);
        
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({
                error: 'Failed to fetch configuration',
                details: error.message
            })
        };
    }
};
