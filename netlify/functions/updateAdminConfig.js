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
    // Verify admin token
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

    // Parse request body
    const updates = JSON.parse(event.body);
    
    console.log('📝 UPDATE REQUEST RECEIVED');
    console.log('📝 Full payload:', JSON.stringify(updates, null, 2));
    console.log('📝 Branding in payload:', updates.branding ? 'YES' : 'NO');
    if (updates.branding) {
      console.log('📝 Branding colors:', JSON.stringify(updates.branding.colors, null, 2));
    }

    // ✅ CRITICAL: Prepare the update object
    const updateData = {
      maintenanceMode: updates.maintenanceMode || false,
      chatWidgetEnabled: updates.chatWidgetEnabled || false,
      ipWhitelist: updates.ipWhitelist || [],
      chatSchedule: {
        enableTime: updates.chatSchedule?.enableTime || '08:00',
        disableTime: updates.chatSchedule?.disableTime || '20:00',
        activeDays: updates.chatSchedule?.activeDays || [1, 2, 3, 4, 5]
      },
      lastUpdated: admin.firestore.FieldValue.serverTimestamp()
    };

    // ✅ CRITICAL: Add branding if it exists
    if (updates.branding) {
      updateData.branding = {
        logoUrl: updates.branding.logoUrl || '/images/AutoInx logo.png',
        headerText: {
          en: updates.branding.headerText?.en || 'Catalog',
          es: updates.branding.headerText?.es || 'Catálogo'
        },
        colors: {
          backgroundStart: updates.branding.colors?.backgroundStart || '#f0f9ff',
          backgroundEnd: updates.branding.colors?.backgroundEnd || '#e0e7ff',
          addToCart: updates.branding.colors?.addToCart || '#ec4899',
          checkout: updates.branding.colors?.checkout || '#ec4899'
        }
      };
      console.log('✅ Branding data prepared for Firestore:', JSON.stringify(updateData.branding, null, 2));
    }

    console.log('📝 Writing to Firestore: admin/config');
    console.log('📝 Data being written:', JSON.stringify(updateData, null, 2));

    // ✅ Write to Firestore
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
        brandingSaved: !!updates.branding
      })
    };

  } catch (error) {
    console.error('❌ ERROR in updateAdminConfig:', error);
    console.error('❌ Stack trace:', error.stack);
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
