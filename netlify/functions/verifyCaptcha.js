// netlify/functions/verifyCaptcha.js

const fetch = require('node-fetch');

// NEW: Use environment variables for Enterprise verification
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID; 
const GCP_API_KEY = process.env.GCP_API_KEY; 

// The site key from your frontend (6LdiVx4sAAAAAJR3votlSI8nB61NMFmh5YZokFQ-)
const RECAPTCHA_SITE_KEY = '6LdiVx4sAAAAAJR3votlSI8nB61NMFmh5YZokFQ-'; 
const ACTION = 'register'; // The expected action name from your frontend execution

exports.handler = async (event, context) => {
    // 1. Security Check: Only allow POST requests
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    // 2. Enterprise Key Check
    if (!GCP_PROJECT_ID || !GCP_API_KEY) {
        console.error("GCP_PROJECT_ID or GCP_API_KEY is not set.");
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error: Enterprise keys missing.' }) };
    }

    try {
        const { token } = JSON.parse(event.body);

        if (!token) {
            return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Missing reCAPTCHA token.' }) };
        }

        // NEW: Construct the Enterprise API URL
        const VERIFY_URL_ENTERPRISE = `https://recaptchaenterprise.googleapis.com/v1/projects/${GCP_PROJECT_ID}/assessments?key=${GCP_API_KEY}`;
        
        // NEW: Construct the Enterprise request body (Assessment object)
        const requestBody = {
            event: {
                token: token,
                siteKey: RECAPTCHA_SITE_KEY,
                expectedAction: ACTION,
            },
        };

        // 3. Call Google reCAPTCHA Enterprise API for verification
        const response = await fetch(VERIFY_URL_ENTERPRISE, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json' // Must be JSON for Enterprise
            },
            body: JSON.stringify(requestBody)
        });

        const data = await response.json();

        // Check for general API errors
        if (data.error) {
            console.error("reCAPTCHA Enterprise API Error:", data.error.message);
            // This often means invalid API key or PROJECT ID
            return { statusCode: 500, body: JSON.stringify({ success: false, error: 'Enterprise API error.' }) };
        }

        // 4. Enterprise Verification Logic
        // Enterprise returns a "name" property on success and a list of policy violations
        const isTokenValid = data.tokenProperties.valid;
        const actionMatches = data.tokenProperties.action === ACTION;
        // Adjust score threshold as needed (e.g., require score >= 0.5)
        const scorePasses = data.riskAnalysis.score >= 0.5; 
        
        const success = isTokenValid && actionMatches && scorePasses;

        if (success) {
            return {
                statusCode: 200,
                body: JSON.stringify({ success: true, score: data.riskAnalysis.score }),
            };
        } else {
            console.warn("reCAPTCHA Enterprise check failed:", data.riskAnalysis.reasons);
            return {
                statusCode: 200, 
                body: JSON.stringify({ 
                    success: false, 
                    error: 'reCAPTCHA failed verification.',
                    reasons: data.riskAnalysis.reasons 
                }),
            };
        }

    } catch (error) {
        console.error('Function error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Internal Server Error.' }),
        };
    }
};
