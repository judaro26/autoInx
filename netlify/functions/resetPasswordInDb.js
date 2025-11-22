/**
 * Netlify Function to reset the user's password in Firebase Auth and delete the reset token.
 * Requires Firebase Admin SDK.
 */
const admin = require('firebase-admin');

// Ensure Firebase Admin is initialized once
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // NOTE: privateKey must be handled securely via Netlify environment variables
      privateKey: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
    }),
  });
}

const db = admin.firestore();

exports.handler = async function (event) {
  try {
    // Check if the request method is POST
    if (event.httpMethod !== 'POST') {
      return {
        statusCode: 405,
        body: JSON.stringify({ error: 'Method Not Allowed, only POST is allowed' }),
      };
    }

    // Parse the request body
    let requestBody;
    try {
      requestBody = JSON.parse(event.body);
    } catch (error) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid JSON body' }),
      };
    }

    const { token, newPassword } = requestBody;

    if (!token || !newPassword) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Token and newPassword are required' }),
      };
    }

    console.log('Received request to reset password with token:', token);

    // Step 1: Validate the token
    const tokenDoc = await db.collection('passwordResetTokens').doc(token).get();
    
    if (!tokenDoc.exists) {
      console.error('Invalid or expired token');
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid or expired token' }),
      };
    }
    
    const tokenData = tokenDoc.data();
    if (tokenData.expiresAt && tokenData.expiresAt.toDate() < new Date()) {
        console.error('Token has expired');
        await db.collection('passwordResetTokens').doc(token).delete(); // Clean up expired token
        return {
            statusCode: 400,
            body: JSON.stringify({ error: 'Token has expired' }),
        };
    }


    const { email } = tokenData;
    console.log('Token is valid for email:', email);

    // Step 2: Reset the password in Firebase Auth
    const user = await admin.auth().getUserByEmail(email);
    await admin.auth().updateUser(user.uid, { password: newPassword });
    console.log('Password updated successfully for user:', email);

    // Step 3: Delete the token
    await db.collection('passwordResetTokens').doc(token).delete();
    console.log('Password reset token deleted');

    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Password reset successfully' }),
    };
  } catch (error) {
    console.error('Error resetting password:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to reset password', details: error.message }),
    };
  }
};
