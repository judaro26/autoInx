/**
 * Netlify Function (AWS Lambda) to securely send contact form submissions via Brevo (Sendinblue) API.
 *
 * It routes the email to 'orders@autoinx.com' or 'support@autoinx.com' based on the 'subjectType' field.
 *
 * NOTE: This function does NOT use an HTML template; it uses plain text/HTML structure directly.
 */

const fetch = require('node-fetch');

exports.handler = async (event, context) => {
    // 1. Basic Validation
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ message: "Method Not Allowed" }) };
    }

    const { BREVO_API_KEY } = process.env;
    if (!BREVO_API_KEY) {
        console.error("Brevo API Key is missing.");
        return { statusCode: 500, body: JSON.stringify({ message: "Server configuration error: Email service unavailable." }) };
    }

    let formData;
    try {
        formData = JSON.parse(event.body);
    } catch (error) {
        return { statusCode: 400, body: JSON.stringify({ message: "Invalid JSON format in request body" }) };
    }

    const { name, email, subjectType, message } = formData;

    if (!name || !email || !subjectType || !message) {
        return { statusCode: 400, body: JSON.stringify({ message: "Missing required contact form details." }) };
    }

    // 2. Email Routing Logic
    let recipientEmail, subjectPrefix;

    if (subjectType === 'order') {
        recipientEmail = "orders@autoinx.com"; // Target for Order Questions
        subjectPrefix = "[ORDER QUERY]";
    } else {
        recipientEmail = "support@autoinx.com"; // Target for General Support/Other
        subjectPrefix = "[SUPPORT]";
    }

    // 3. Construct Email Content
    const emailSubject = `${subjectPrefix} - New Contact Form Submission from ${name}`;
    const htmlContent = `
        <p>You have received a new message from the AutoInx contact form:</p>
        <hr>
        <p><strong>Sender Name:</strong> ${name}</p>
        <p><strong>Sender Email:</strong> ${email}</p>
        <p><strong>Query Type:</strong> ${subjectType}</p>
        <hr>
        <p><strong>Message:</strong></p>
        <div style="border: 1px solid #ccc; padding: 15px; background-color: #f9f9f9; white-space: pre-wrap;">
            ${message}
        </div>
        <br>
        <small>This was automatically routed to <strong>${recipientEmail}</strong>.</small>
    `;

    // 4. Brevo API Payload
    const brevoPayload = {
        sender: {
            name: name,
            email: email // Use the user's email as the sender for easier reply
        },
        to: [{ email: recipientEmail }],
        subject: emailSubject,
        htmlContent: htmlContent,
        // Add a replyTo header to ensure replies go directly to the customer
        replyTo: { email: email, name: name }
    };

    // 5. Call Brevo API
    try {
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
            return {
                statusCode: brevoResponse.status,
                body: JSON.stringify({ message: "Failed to send email via Brevo API.", details: errorText })
            };
        }

        return {
            statusCode: 200,
            body: JSON.stringify({ message: "Contact email sent successfully." })
        };

    } catch (error) {
        console.error("Critical error during Brevo fetch:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "Internal server error during email transaction." })
        };
    }
};
