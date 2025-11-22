/**
 * Netlify Function that is the target of the password reset email link.
 * It validates the token and redirects the user to the password reset form page.
 * Requires Firebase Admin SDK.
 */
const admin = require('firebase-admin');

// Ensure Firebase Admin is initialized once
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
    }),
  });
}

const db = admin.firestore();
const SITE_URL = process.env.URL || 'https://autoinx-placeholder.netlify.app';

exports.handler = async function (event) {
  console.log('Received event for token validation:', event.queryStringParameters);

  try {
    if (event.httpMethod !== 'GET') {
      return {
        statusCode: 405,
        body: JSON.stringify({ error: 'Method Not Allowed, only GET is allowed' }),
      };
    }

    const token = event.queryStringParameters.token;
    console.log('Received token:', token);

    if (!token) {
      return {
        statusCode: 302,
          headers: {
            Location: `${SITE_URL}/passwordResetPage.html?status=error&message=Token is missing.`,
          },
      };
    }

    // Check token existence and expiry in Firestore
    const tokenDoc = await db.collection('passwordResetTokens').doc(token).get();
    
    if (!tokenDoc.exists) {
      console.log('Invalid or expired token');
      return {
        statusCode: 302,
          headers: {
            Location: `${SITE_URL}/passwordResetPage.html?status=error&message=Invalid or expired token.`,
          },
      };
    }
    
    const tokenData = tokenDoc.data();
    if (tokenData.expiresAt && tokenData.expiresAt.toDate() < new Date()) {
        console.log('Token has expired');
        return {
            statusCode: 302,
            headers: {
              Location: `${SITE_URL}/passwordResetPage.html?status=error&message=Token has expired.`,
            },
        };
    }

    console.log('Token validated successfully');

    // Redirect to the actual password reset page with a success status and the valid token
    return {
      statusCode: 302,
      headers: {
        Location: `${SITE_URL}/passwordResetPage.html?status=success&message=Token validated successfully&token=${token}`,
      },
    };
  } catch (error) {
    console.error('Error validating token:', error);
    return {
      statusCode: 302,
      headers: {
        Location: `${SITE_URL}/passwordResetPage.html?status=error&message=A server error occurred during validation.`,
      },
    };
  }
};
