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
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return {
        statusCode: 401,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Authorization token required.' })
      };
    }

    const idToken = authHeader.split('Bearer ')[1];
    const decodedToken = await admin.auth().verifyIdToken(idToken);

    if (!decodedToken.admin) {
      return {
        statusCode: 403,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Admin access required.' })
      };
    }

    const updates = JSON.parse(event.body);

    console.log('📝 UPDATE REQUEST RECEIVED');
    console.log('📝 Full payload:', JSON.stringify(updates, null, 2));

    const updateData = {
      maintenanceMode:   updates.maintenanceMode   || false,
      chatWidgetEnabled: updates.chatWidgetEnabled || false,
      ipWhitelist:       updates.ipWhitelist       || [],
      chatSchedule: {
        enableTime:  updates.chatSchedule?.enableTime  || '08:00',
        disableTime: updates.chatSchedule?.disableTime || '20:00',
        activeDays:  updates.chatSchedule?.activeDays  || [1, 2, 3, 4, 5]
      },
      lastUpdated: admin.firestore.FieldValue.serverTimestamp()
    };

    // Branding — includes all six color fields
    if (updates.branding) {
      updateData.branding = {
        logoUrl: updates.branding.logoUrl || '/images/AutoInx logo.png',
        headerText: {
          en: updates.branding.headerText?.en || 'Catalog',
          es: updates.branding.headerText?.es || 'Catálogo'
        },
        colors: {
          backgroundStart: updates.branding.colors?.backgroundStart || '#f0f9ff',
          backgroundEnd:   updates.branding.colors?.backgroundEnd   || '#e0e7ff',
          addToCart:       updates.branding.colors?.addToCart       || '#ec4899',
          checkout:        updates.branding.colors?.checkout        || '#ec4899',
          categoryActive:  updates.branding.colors?.categoryActive  || '#4f46e5',
          productBtn:      updates.branding.colors?.productBtn      || '#4f46e5',
        }
      };
      console.log('✅ Branding prepared:', JSON.stringify(updateData.branding, null, 2));
    }

    // Seasonal banner
    if (updates.seasonalBanner !== undefined) {
      updateData.seasonalBanner = {
        enabled: updates.seasonalBanner.enabled === true,
        theme:   updates.seasonalBanner.theme   || 'stpatricks',
        message: updates.seasonalBanner.message || ''
      };
      console.log('✅ Seasonal banner prepared:', JSON.stringify(updateData.seasonalBanner));
    }

    await db.collection('admin').doc('config').set(updateData, { merge: true });
    console.log('✅✅✅ CONFIG UPDATED IN FIRESTORE ✅✅✅');

    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        success: true,
        message: 'Configuration updated successfully',
        brandingSaved: !!updates.branding,
        seasonalBannerSaved: updates.seasonalBanner !== undefined
      })
    };

  } catch (error) {
    console.error('❌ ERROR in updateAdminConfig:', error);
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        error: 'Failed to update configuration',
        details: error.message
      })
    };
  }
};
