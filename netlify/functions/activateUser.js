/**
 * Netlify Function that is the target of the activation email link.
 * It validates the token, creates the user in Firebase Auth, and redirects to the home page.
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
const auth = admin.auth();
const SITE_URL = process.env.URL || 'https://autoinx-placeholder.netlify.app';

exports.handler = async function (event) {
  console.log('Received event for activation validation:', event.queryStringParameters);

  try {
    if (event.httpMethod !== 'GET') {
      return {
        statusCode: 405,
        body: JSON.stringify({ error: 'Method Not Allowed, only GET is allowed' }),
      };
    }

    const token = event.queryStringParameters.token;
    if (!token) {
      return {
        statusCode: 302,
          headers: {
            Location: `${SITE_URL}/?activation_status=error&message=Activation token is missing.`,
          },
      };
    }

    // Step 1: Check token existence and expiry in Firestore
    const tokenDocRef = db.collection('activationTokens').doc(token);
    const tokenDoc = await tokenDocRef.get();
    
    if (!tokenDoc.exists) {
      return {
        statusCode: 302,
          headers: {
            Location: `${SITE_URL}/?activation_status=error&message=Invalid or expired activation link.`,
          },
      };
    }
    
    const tokenData = tokenDoc.data();
    if (tokenData.expiresAt && tokenData.expiresAt.toDate() < new Date()) {
        await tokenDocRef.delete(); // Clean up expired token
        return {
            statusCode: 302,
            headers: {
              Location: `${SITE_URL}/?activation_status=error&message=Activation link has expired.`,
            },
        };
    }

    const { email, password, phone } = tokenData;

    // Step 2: Create the user in Firebase Auth
    try {
        await auth.createUser({
            email: email,
            password: password,
            phoneNumber: phone || undefined,
            emailVerified: true, // Mark as verified since they clicked the link
            disabled: false,
        });
    } catch (authError) {
        // If the user already exists, we suppress the error and proceed to token cleanup
        if (authError.code !== 'auth/email-already-in-use') {
            console.error('Error creating user in Firebase Auth:', authError);
            return {
                statusCode: 302,
                headers: {
                  Location: `${SITE_URL}/?activation_status=error&message=User creation failed. Please contact support.`,
                },
            };
        }
    }

    // Step 3: Delete the token
    await tokenDocRef.delete();

    // Step 4: Redirect to the home page with a success message
    return {
      statusCode: 302,
      headers: {
        Location: `${SITE_URL}/?activation_status=success&message=Account activated successfully! You can now log in.`,
      },
    };
  } catch (error) {
    console.error('Error during user activation:', error);
    return {
      statusCode: 302,
      headers: {
        Location: `${SITE_URL}/?activation_status=error&message=A server error occurred during activation.`,
      },
    };
  }
};
