/**
 * Netlify Function to generate a reset token, store it, and send a password reset email
 * using the Brevo HTTP API and a local HTML template.
 */
const fetch = require('node-fetch');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// The base URL of the deployed Netlify site (where passwordResetPage.html lives)
const SITE_URL = process.env.URL || 'https://autoinx-placeholder.netlify.app'; 
const SENDER_EMAIL = "noreply@autoinx.com"; // IMPORTANT: Use a verified sender email in your Brevo account

async function getEmailHtml() {
  try {
    // Read the template content synchronously from the local file system
    const templatePath = path.join(__dirname, 'emailTemplates', 'passwordResetTemplate.html');
    const template = fs.readFileSync(templatePath, 'utf8');
    return template;
  } catch (error) {
    console.error('Error reading local email template:', error);
    throw new Error('Failed to read local email template');
  }
}

async function sendPasswordResetEmail(email, passwordResetToken) {
    const BREVO_API_KEY = process.env.BREVO_API_KEY;
    if (!BREVO_API_KEY) {
        throw new Error("Brevo API Key is missing.");
    }

    // The reset link points to the Netlify function that validates the token and redirects
    const resetLink = `${SITE_URL}/.netlify/functions/passwordReset?token=${passwordResetToken}`; 
    console.log('Generated Password Reset Link:', resetLink);

    const emailHtml = await getEmailHtml();

    if (!emailHtml.includes('{{resetLink}}')) {
        throw new Error('Placeholder {{resetLink}} not found in email template');
    }

    // Replace placeholders in the email template
    // Note: Brevo handles {{contact.EMAIL}} automatically if sent in the "to" field.
    let modifiedHtml = emailHtml.replace(/{{resetLink}}/g, resetLink);

    const brevoPayload = {
        sender: {
            name: "autoInx Support",
            email: SENDER_EMAIL
        },
        to: [{ email: email }],
        subject: 'Reset Your autoInx Password',
        htmlContent: modifiedHtml,
        // Using Brevo's system for contact placeholders
        params: {
            EMAIL: email // Pass email as a parameter for manual substitution if needed, but the template uses {{contact.EMAIL}}
        }
    };

    const brevoResponse = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'api-key': BREVO_API_KEY
        },
        body: JSON.stringify(brevoPayload)
    });

    if (!brevoResponse.ok) {
        const errorText = await brevoResponse.text();
        console.error(`Brevo API Error (${brevoResponse.status}):`, errorText);
        throw new Error(`Brevo API failure: ${brevoResponse.status}`);
    }

    console.log('Password reset email sent successfully.');
}

async function storePasswordResetToken(email, passwordResetToken) {
    const storeFunctionUrl = `${SITE_URL}/.netlify/functions/storePasswordToken`;

    const response = await fetch(storeFunctionUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, passwordResetToken }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Failed to store password reset token:', errorText);
      throw new Error('Failed to store password reset token');
    }
    console.log('Stored password reset token successfully.');
}

function generatePasswordResetToken() {
  return crypto.randomBytes(20).toString('hex');
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }
    
    const { email } = JSON.parse(event.body);
    console.log('Received reset request for email:', email);
    
    // Check if the email exists in Firebase Auth before proceeding (optional but recommended)
    try {
        await admin.auth().getUserByEmail(email);
    } catch(authError) {
        // If the user doesn't exist, we still return a success message for security (avoids revealing valid emails)
        console.log(`User ${email} not found in Auth. Returning success silently.`);
        return { statusCode: 200, body: JSON.stringify({ message: 'If the email exists, a reset link has been sent.' }) };
    }


    // Step 1: Generate password reset token
    const passwordResetToken = generatePasswordResetToken();

    // Step 2: Store token and data (calls storePasswordToken.js)
    await storePasswordResetToken(email, passwordResetToken);

    // Step 3: Send password reset email
    await sendPasswordResetEmail(email, passwordResetToken);

    return { statusCode: 200, body: JSON.stringify({ message: 'Password reset link sent successfully' }) };
  } catch (error) {
    console.error('Error processing password reset request:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to process request', details: error.message }) };
  }
};
