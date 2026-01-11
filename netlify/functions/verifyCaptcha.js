const fetch = require('node-fetch');

// These must be set in your Netlify Environment Variables
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID; 
const GCP_API_KEY = process.env.GCP_API_KEY; 

// Ensure this matches the key created in project: creditx-3c488
const RECAPTCHA_SITE_KEY = '6LdiVx4sAAAAAJR3votlSI8nB61NMFmh5YZokFQ-'; 
const ACTION = 'register'; 

exports.handler = async (event, context) => {
    // 1. Security Check: Only allow POST requests
    if (event.httpMethod !== 'POST') {
        return { 
            statusCode: 405, 
            body: JSON.stringify({ error: 'Method Not Allowed' }) 
        };
    }

    // 2. Configuration Check
    if (!GCP_PROJECT_ID || !GCP_API_KEY) {
        console.error("CRITICAL: GCP_PROJECT_ID or GCP_API_KEY is not set in Netlify.");
        return { 
            statusCode: 500, 
            body: JSON.stringify({ error: 'Server configuration error.' }) 
        };
    }

    try {
        const body = JSON.parse(event.body);
        const token = body.token;

        if (!token) {
            return { 
                statusCode: 400, 
                body: JSON.stringify({ success: false, error: 'Missing reCAPTCHA token.' }) 
            };
        }

        // Construct the Enterprise API URL using your Project ID and API Key
        const VERIFY_URL = `https://recaptchaenterprise.googleapis.com/v1/projects/${GCP_PROJECT_ID}/assessments?key=${GCP_API_KEY}`;
        
        const requestBody = {
            event: {
                token: token,
                siteKey: RECAPTCHA_SITE_KEY,
                expectedAction: ACTION,
            },
        };

        // 3. Call Google reCAPTCHA Enterprise API
        const response = await fetch(VERIFY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
        });

        const data = await response.json();

        // --- ERROR HANDLING BLOCK ---
        // Catch API-level errors (like project mismatch or invalid API keys)
        if (data.error) {
            console.error("Google API Error:", data.error.message);
            return { 
                statusCode: 400, 
                body: JSON.stringify({ success: false, error: data.error.message }) 
            };
        }

        // Catch malformed responses to prevent code crashes
        if (!data.tokenProperties || !data.riskAnalysis) {
            console.error("Unexpected response structure from Google:", data);
            return { 
                statusCode: 500, 
                body: JSON.stringify({ success: false, error: 'Malformed verification response.' }) 
            };
        }

        // 4. Enterprise Verification Logic
        const isTokenValid = data.tokenProperties.valid;
        const actionMatches = data.tokenProperties.action === ACTION;
        const scorePasses = data.riskAnalysis.score >= 0.5; 
        
        const success = isTokenValid && actionMatches && scorePasses;

        if (success) {
            console.log(`Verification successful. Score: ${data.riskAnalysis.score}`);
            return {
                statusCode: 200,
                body: JSON.stringify({ 
                    success: true, 
                    score: data.riskAnalysis.score 
                }),
            };
        } else {
            console.warn("reCAPTCHA failed. Reason:", data.tokenProperties.invalidReason || 'Low score');
            return {
                statusCode: 200, 
                body: JSON.stringify({ 
                    success: false, 
                    error: 'reCAPTCHA failed verification.',
                    invalidReason: data.tokenProperties.invalidReason,
                    score: data.riskAnalysis.score
                }),
            };
        }

    } catch (error) {
        console.error('Function execution error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Internal Server Error.' }),
        };
    }
};
