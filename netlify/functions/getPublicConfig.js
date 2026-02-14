const admin = require('firebase-admin');

// Import IP whitelist from shared utilities
const { ipWhitelist: staticIpWhitelist } = require('../../js/utilities/ipWhitelist.js');

// Initialize Firebase Admin (only once)
if (!admin.apps.length) {
    // ✅ Add validation for environment variable
    const serviceAccountKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    
    if (!serviceAccountKey) {
        console.error('FIREBASE_SERVICE_ACCOUNT_KEY environment variable is not set');
        throw new Error('Missing Firebase service account configuration');
    }

    let serviceAccount;
    try {
        serviceAccount = JSON.parse(serviceAccountKey);
    } catch (parseError) {
        console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT_KEY:', parseError.message);
        throw new Error('Invalid Firebase service account JSON');
    }

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
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
        const configDoc = await db.collection('config').doc('admin').get();
        
        if (configDoc.exists) {
            const dynamicWhitelist = configDoc.data().ipWhitelist || [];
            return dynamicWhitelist.includes(clientIp);
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
        const configRef = db.collection('config').doc('admin');
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
