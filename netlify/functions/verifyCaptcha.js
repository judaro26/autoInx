// netlify/functions/verifyCaptcha.js

const fetch = require('node-fetch');

// The Secret Key is automatically injected from the Netlify Environment Variables
const RECAPTCHA_SECRET_KEY = process.env.RECAPTCHA_SECRET_KEY;
const VERIFY_URL = 'https://www.google.com/recaptcha/api/siteverify';

exports.handler = async (event, context) => {
    // 1. Security Check: Only allow POST requests
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            body: JSON.stringify({ error: 'Method Not Allowed' }),
        };
    }

    // 2. Secret Key Check
    if (!RECAPTCHA_SECRET_KEY) {
        console.error("RECAPTCHA_SECRET_KEY is not set in environment variables.");
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Server configuration error.' }),
        };
    }

    try {
        const { token } = JSON.parse(event.body);

        if (!token) {
            return {
                statusCode: 400,
                body: JSON.stringify({ success: false, error: 'Missing reCAPTCHA token.' }),
            };
        }

        // 3. Call Google reCAPTCHA API for verification
        const response = await fetch(VERIFY_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: `secret=${RECAPTCHA_SECRET_KEY}&response=${token}`
        });

        const data = await response.json();

        // 4. Respond to client
        if (data.success) {
            // Optional: You can check the score for v3 here (data.score)
            return {
                statusCode: 200,
                body: JSON.stringify({ success: true, score: data.score || 1.0 }),
            };
        } else {
            console.warn("reCAPTCHA verification failed:", data['error-codes']);
            return {
                statusCode: 200, // Return 200 but indicate failure
                body: JSON.stringify({ success: false, error: 'reCAPTCHA failed verification.' }),
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
