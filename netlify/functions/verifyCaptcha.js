const fetch = require('node-fetch');

const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID;
const GCP_API_KEY = process.env.GCP_API_KEY;

// ✅ Must match the key used in index.html exactly
const RECAPTCHA_SITE_KEY = '6LdZFEcsAAAAAHlpQm8kzy0SbkE1uTKuaE9uAo6J';
const ACTION = 'register';

exports.handler = async (event, context) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    if (!GCP_PROJECT_ID || !GCP_API_KEY) {
        console.error("CRITICAL: GCP_PROJECT_ID or GCP_API_KEY is not set in Netlify.");
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }

    try {
        const body = JSON.parse(event.body);
        const token = body.token;

        if (!token) {
            return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Missing reCAPTCHA token.' }) };
        }

        const VERIFY_URL = `https://recaptchaenterprise.googleapis.com/v1/projects/${GCP_PROJECT_ID}/assessments?key=${GCP_API_KEY}`;

        const requestBody = {
            event: {
                token: token,
                siteKey: RECAPTCHA_SITE_KEY,
                expectedAction: ACTION,
            },
        };

        const response = await fetch(VERIFY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
        });

        const data = await response.json();

        if (data.error) {
            console.error("Google API Error:", data.error.message);
            return { statusCode: 400, body: JSON.stringify({ success: false, error: data.error.message }) };
        }

        if (!data.tokenProperties || !data.riskAnalysis) {
            console.error("Unexpected response structure from Google:", data);
            return { statusCode: 500, body: JSON.stringify({ success: false, error: 'Malformed verification response.' }) };
        }

        const isTokenValid = data.tokenProperties.valid;
        const actionMatches = data.tokenProperties.action === ACTION;
        const scorePasses = data.riskAnalysis.score >= 0.5;
        const success = isTokenValid && actionMatches && scorePasses;

        if (success) {
            // ✅ Fixed: added opening parenthesis
            console.log(`Verification successful. Score: ${data.riskAnalysis.score}`);
            return {
                statusCode: 200,
                body: JSON.stringify({ success: true, score: data.riskAnalysis.score }),
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
        return { statusCode: 500, body: JSON.stringify({ error: 'Internal Server Error.' }) };
    }
};
