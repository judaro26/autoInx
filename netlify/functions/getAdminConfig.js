const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    })
  });
}

const db = admin.firestore();

exports.handler = async (event) => {
  // Allow CORS
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, OPTIONS'
      },
      body: ''
    };
  }

  try {
    console.log('📥 Fetching admin config from Firestore...');
    
    // ✅ CRITICAL: Read from admin/config (same path where updateAdminConfig writes)
    const configDoc = await db.collection('admin').doc('config').get();

    if (!configDoc.exists) {
      console.warn('⚠️ Config document does not exist, returning defaults');
      return {
        statusCode: 200,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          maintenanceMode: false,
          chatWidgetEnabled: false,
          ipWhitelist: [],
          staticIpWhitelist: [],
          chatSchedule: {
            enableTime: '08:00',
            disableTime: '20:00',
            activeDays: [1, 2, 3, 4, 5]
          },
          branding: {
            logoUrl: '/images/AutoInx logo.png',
            headerText: { en: 'Catalog', es: 'Catálogo' },
            colors: {
              backgroundStart: '#f0f9ff',
              backgroundEnd: '#e0e7ff',
              addToCart: '#ec4899',
              checkout: '#ec4899'
            }
          }
        })
      };
    }

    const configData = configDoc.data();
    console.log('✅ Config data retrieved:', JSON.stringify(configData, null, 2));

    // ✅ CRITICAL: Make sure branding is included
    const response = {
      maintenanceMode: configData.maintenanceMode || false,
      chatWidgetEnabled: configData.chatWidgetEnabled || false,
      ipWhitelist: configData.ipWhitelist || [],
      staticIpWhitelist: configData.staticIpWhitelist || [],
      chatSchedule: configData.chatSchedule || {
        enableTime: '08:00',
        disableTime: '20:00',
        activeDays: [1, 2, 3, 4, 5]
      },
      branding: configData.branding || {
        logoUrl: '/images/AutoInx logo.png',
        headerText: { en: 'Catalog', es: 'Catálogo' },
        colors: {
          backgroundStart: '#f0f9ff',
          backgroundEnd: '#e0e7ff',
          addToCart: '#ec4899',
          checkout: '#ec4899'
        }
      },
      lastUpdated: configData.lastUpdated || null
    };

    console.log('📤 Returning response with branding:', JSON.stringify(response.branding, null, 2));

    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(response)
    };

  } catch (error) {
    console.error('❌ Error fetching config:', error);
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        error: 'Failed to fetch configuration',
        details: error.message
      })
    };
  }
};
