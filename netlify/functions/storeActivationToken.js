/**
 * Netlify Function to store a new user's registration data and an activation token in Firestore.
 * This is a temporary staging area until the user clicks the activation link.
 */
const admin = require('firebase-admin');

// Ensure Firebase Admin is initialized once
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // NOTE: private_key must be handled securely via Netlify environment variables
      privateKey: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
    }),
  });
}

const db = admin.firestore();

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method Not Allowed' }),
    };
  }

  let requestBody;
  try {
    requestBody = JSON.parse(event.body);
  } catch (error) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Invalid JSON body' }),
    };
  }

  const { email, password, phone, smsConsentStatus, activationToken } = requestBody;

  if (!email || !password || !activationToken) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Email, password, and activationToken are required' }),
    };
  }

  try {
    // Store the token with the associated user data and set expiry to 24 hours
    await db.collection('activationTokens').doc(activationToken).set({
      email: email,
      password: password, // Stored temporarily until activation
      phone: phone || null,
      smsConsentStatus: smsConsentStatus || 'declined',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000), 
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Activation token and user data stored successfully', token: activationToken }),
    };
  } catch (error) {
    console.error('Error storing activation token:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to store activation token', details: error.message }),
    };
  }
};
