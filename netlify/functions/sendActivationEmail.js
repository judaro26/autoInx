/**
 * Netlify Function to send an account activation email using the Brevo HTTP API and a local HTML template.
 */
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

// The base URL of the deployed Netlify site
const SITE_URL = process.env.URL || 'https://autoinx-placeholder.netlify.app'; 
const SENDER_EMAIL = process.env.SENDER_EMAIL || "noreply@autoinx.com"; 
const ACTIVATION_FUNCTION_PATH = '/.netlify/functions/activateUser'; // Target for the email link

async function getEmailHtml() {
  try {
    const templatePath = path.join(__dirname, 'emailTemplates', 'emailActivationTemplate.html');
    const template = fs.readFileSync(templatePath, 'utf8');
    return template;
  } catch (error) {
    console.error('Error reading local activation email template:', error);
    throw new Error('Failed to read local email template');
  }
}

async function sendActivationEmail(email, activationToken) {
    const BREVO_API_KEY = process.env.BREVO_API_KEY;
    if (!BREVO_API_KEY) {
        throw new Error("Brevo API Key is missing.");
    }

    const activationLink = `${SITE_URL}${ACTIVATION_FUNCTION_PATH}?token=${activationToken}`; 
    console.log('Generated Account Activation Link:', activationLink);

    const emailHtml = await getEmailHtml();
    let modifiedHtml = emailHtml.replace(/{{activationLink}}/g, activationLink);

    const brevoPayload = {
        sender: {
            name: "autoInx Support",
            email: SENDER_EMAIL
        },
        to: [{ email: email }],
        subject: 'Action Required: Activate Your autoInx Account',
        htmlContent: modifiedHtml,
        params: {
            EMAIL: email 
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

    console.log('Account activation email sent successfully.');
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }
    
    const { email, token } = JSON.parse(event.body);

    if (!email || !token) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Email and token are required' }) };
    }

    await sendActivationEmail(email, token);

    return { statusCode: 200, body: JSON.stringify({ message: 'Activation email sent successfully' }) };
  } catch (error) {
    console.error('Error processing activation email request:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to process request', details: error.message }) };
  }
};
