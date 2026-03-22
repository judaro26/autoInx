/**
 * getAboutConfig.js — public Netlify function
 * Returns the about page configuration stored in Firestore at site_config/about.
 * No auth required — this is public content.
 */
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY
        ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
        : undefined,
    }),
  });
}

const db = admin.firestore();

exports.handler = async function (event) {
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    try {
        const snap = await db.collection('site_config').doc('about').get();
        const data = snap.exists ? snap.data() : null;

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'public, max-age=60', // cache for 1 min
            },
            body: JSON.stringify(data || {}),
        };
    } catch (err) {
        console.error('getAboutConfig error:', err);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to load about config' }),
        };
    }
};
