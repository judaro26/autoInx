/**
 * Netlify Function to store a password reset token and associated email in Firestore.
 * This function requires Firebase Admin SDK.
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

  const { email, passwordResetToken } = requestBody;

  if (!email || !passwordResetToken) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Email and passwordResetToken are required' }),
    };
  }

  try {
    // Store the token with the associated email and creation time (e.g., set expiry to 1 hour)
    await db.collection('passwordResetTokens').doc(passwordResetToken).set({
      email: email,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: new Date(Date.now() + 3600 * 1000), // Token expires in 1 hour
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Token stored successfully', token: passwordResetToken }),
    };
  } catch (error) {
    console.error('Error storing password reset token:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to store token', details: error.message }),
    };
  }
};
