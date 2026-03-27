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

// ── Module-level cache (shared across warm invocations, 60s TTL) ─────────────
let _cachedConfig   = null;
let _cacheExpiresAt = 0;
const CACHE_TTL_MS  = 60 * 1000;

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

// Called by updateAdminConfig after a successful write to bust the cache.
exports.clearCache = function() {
    _cachedConfig   = null;
    _cacheExpiresAt = 0;
};

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

  // ?nocache=1 bypasses both module cache and CDN — used by admin panel after saving
  const nocache = !!(
      event.queryStringParameters?.nocache === '1' ||
      event.rawUrl?.includes('nocache=1') ||
      event.path?.includes('nocache=1')
  );

  // Serve from module-level cache if fresh (skipped when nocache=1)
  const now = Date.now();
  if (!nocache && _cachedConfig && now < _cacheExpiresAt) {
    const clientIp =
        event.headers['x-forwarded-for']?.split(',')[0].trim() ||
        event.headers['client-ip'] ||
        event.requestContext?.identity?.sourceIp || null;
    const isRequesterAdmin =
        STATIC_IP_WHITELIST.includes(clientIp) ||
        event.headers['x-admin-override'] === 'true' ||
        (_cachedConfig.ipWhitelist || []).includes(clientIp);
    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json',
                 'Cache-Control': 'public, max-age=60, s-maxage=60', 'X-Cache': 'HIT' },
      body: JSON.stringify({ ..._cachedConfig, isRequesterAdmin, clientIp }),
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

    // Cache for next warm invocation
    _cachedConfig   = { ...response };
    _cacheExpiresAt = Date.now() + CACHE_TTL_MS;

    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json',
        'Cache-Control': nocache
            ? 'no-store, no-cache, must-revalidate'
            : 'public, max-age=60, s-maxage=60',
        'X-Cache': 'MISS',
      },
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
