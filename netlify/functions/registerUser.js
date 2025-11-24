/**
 * Netlify Function to handle new user registration requests.
 * It generates an activation token, stores user data temporarily, and sends an activation email.
 */
const fetch = require('node-fetch');
const crypto = require('crypto');

// The base URL of the deployed Netlify site
const SITE_URL = process.env.URL || 'https://autoinx-placeholder.netlify.app';

// Local Netlify Functions URLs
const STORE_TOKEN_FUNCTION_URL = `${SITE_URL}/.netlify/functions/storeActivationToken`;
const SEND_EMAIL_FUNCTION_URL = `${SITE_URL}/.netlify/functions/sendActivationEmail`;

function generateActivationToken() {
  return crypto.randomBytes(20).toString('hex');
}

async function storeActivationToken(email, password, phone, smsConsentStatus, activationToken) {
    const response = await fetch(STORE_TOKEN_FUNCTION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, phone, smsConsentStatus, activationToken }),
    });

    if (!response.ok) {
        const errorData = await response.json();
        console.error('Failed to store activation token:', errorData.details);
        throw new Error('Failed to store activation token');
    }
}

async function sendActivationEmail(email, activationToken) {
    const response = await fetch(SEND_EMAIL_FUNCTION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, token: activationToken }),
    });

    if (!response.ok) {
        const errorData = await response.json();
        console.error('Failed to send activation email:', errorData.details);
        throw new Error('Failed to send activation email');
    }
}

exports.handler = async function (event) {
  try {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }
    
    const { email, password, phone, smsConsentStatus } = JSON.parse(event.body);

    if (!email || !password) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: 'Email and password are required' }),
        };
    }
    
    // Step 1: Generate activation token
    const activationToken = generateActivationToken();

    // Step 2: Store token and data
    await storeActivationToken(email, password, phone, smsConsentStatus, activationToken);

    // Step 3: Send activation email
    await sendActivationEmail(email, activationToken);

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Activation token stored and activation email sent successfully',
        activationToken,
      }),
    };
  } catch (error) {
    console.error('Error processing registration request:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to process registration', details: error.message }),
    };
  }
};
