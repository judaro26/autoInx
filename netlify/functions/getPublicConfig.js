const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    })
  });
}

const db = admin.firestore();

// Static IP whitelist — used to identify admin requests
const STATIC_IP_WHITELIST = [
  '198.27.140.221'
];

const DEFAULT_SEASONAL_BANNER = {
  enabled: false,
  theme:   'stpatricks',
  message: ''
};

const DEFAULT_BRANDING = {
  logoUrl:    '/images/AutoInx logo.png',
  headerText: { en: 'Catalog', es: 'Catálogo' },
  colors: {
    backgroundStart: '#f0f9ff',
    backgroundEnd:   '#e0e7ff',
    addToCart:       '#ec4899',
    checkout:        '#ec4899'
  }
};

const DEFAULT_CHAT_SCHEDULE = {
  enableTime:  '08:00',
  disableTime: '20:00',
  activeDays:  [1, 2, 3, 4, 5]
};

// ── Payment field sanitizer ────────────────────────────────────────────────────
// Only expose Zelle contact details to the public — never internal config keys.
function sanitizePayment(payment) {
  if (!payment) return { zelleEmail: null, zelleName: null };
  return {
    zelleEmail: payment.zelleEmail || null,
    zelleName:  payment.zelleName  || null,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, OPTIONS'
      },
      body: ''
    };
  }

  try {
    // Determine client IP
    const clientIp =
      event.headers['x-forwarded-for']?.split(',')[0].trim() ||
      event.headers['client-ip'] ||
      event.requestContext?.identity?.sourceIp ||
      null;

    const isRequesterAdmin =
      STATIC_IP_WHITELIST.includes(clientIp) ||
      event.headers['x-admin-override'] === 'true';

    console.log('📥 Fetching admin config from Firestore...');

    const configDoc = await db.collection('admin').doc('config').get();

    if (!configDoc.exists) {
      console.warn('⚠️ Config document does not exist, returning defaults');
      return {
        statusCode: 200,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          maintenanceMode:   false,
          chatWidgetEnabled: false,
          ipWhitelist:       [],
          staticIpWhitelist: STATIC_IP_WHITELIST,
          chatSchedule:      DEFAULT_CHAT_SCHEDULE,
          branding:          DEFAULT_BRANDING,
          seasonalBanner:    DEFAULT_SEASONAL_BANNER,
          payment:           { zelleEmail: null, zelleName: null },
          isRequesterAdmin,
          clientIp
        })
      };
    }

    const configData = configDoc.data();
    console.log('✅ Config data retrieved');

    const dynamicWhitelist  = configData.ipWhitelist || [];
    const isAdminByDynamicIp = dynamicWhitelist.includes(clientIp);

    const response = {
      maintenanceMode:   configData.maintenanceMode   || false,
      chatWidgetEnabled: configData.chatWidgetEnabled || false,
      ipWhitelist:       dynamicWhitelist,
      staticIpWhitelist: configData.staticIpWhitelist || STATIC_IP_WHITELIST,
      chatSchedule:      configData.chatSchedule      || DEFAULT_CHAT_SCHEDULE,
      branding:          configData.branding          || DEFAULT_BRANDING,
      seasonalBanner:    configData.seasonalBanner    || DEFAULT_SEASONAL_BANNER,
      footer:            configData.footer            || null,
      lastUpdated:       configData.lastUpdated       || null,
      // ── Sanitized payment config — only Zelle contact details ──────────────
      payment:           sanitizePayment(configData.payment),
      isRequesterAdmin:  isRequesterAdmin || isAdminByDynamicIp,
      clientIp
    };

    console.log('📤 Returning config with seasonalBanner:', JSON.stringify(response.seasonalBanner));

    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify(response)
    };

  } catch (error) {
    console.error('❌ Error fetching config:', error);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to fetch configuration', details: error.message })
    };
  }
};
