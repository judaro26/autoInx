/**
 * Netlify Function (AWS Lambda) to securely send an order confirmation email via Brevo (Sendinblue) API.
 *
 * This version reads the HTML template from the filesystem (netlify/functions/emailTemplates/orderConfirmationTemplate.html)
 * and dynamically injects the order details before sending.
 *
 * The Brevo API Key must be set in Netlify's environment variables as BREVO_API_KEY.
 */

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

// Helper to format price from cents to a currency string
const formatPrice = (priceInCents) => `$${(priceInCents / 100).toFixed(2)}`;

// 1. Generate the HTML table ROWS dynamically, which will be injected into {{params.orderTableRows}}
const generateOrderTableRows = (items) => {
    return items.map(entry => `
        <tr>
            <td style="padding: 10px; border-bottom: 1px solid #ddd; font-size: 14px;">${entry.name}</td>
            <td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: right; font-size: 14px;">${entry.quantity}</td>
            <td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: right; font-size: 14px;">${formatPrice(entry.price)}</td>
            <td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: right; font-size: 14px; font-weight: bold;">${formatPrice(entry.price * entry.quantity)}</td>
        </tr>
    `).join('');
};

exports.handler = async (event, context) => {
    // Check for POST method
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ message: "Method Not Allowed" }) };
    }

    const { BREVO_API_KEY } = process.env;
    if (!BREVO_API_KEY) {
        console.error("Brevo API Key is missing in environment variables.");
        return { statusCode: 500, body: JSON.stringify({ message: "Server configuration error: Email service unavailable." }) };
    }

    let order;
    try {
        order = JSON.parse(event.body);
    } catch (error) {
        return { statusCode: 400, body: JSON.stringify({ message: "Invalid JSON format in request body" }) };
    }

    const { buyerEmail, items, totalCents, orderId, timestamp } = order;

    if (!buyerEmail || !items || !totalCents || !orderId || !timestamp) {
        return { statusCode: 400, body: JSON.stringify({ message: "Missing required order details." }) };
    }

    // --- 1. Load and Populate Template ---
    let emailHtmlBody;
    try {
        // Construct the path to the HTML template file
        const templatePath = path.join(__dirname, 'emailTemplates', 'orderConfirmationTemplate.html');
        // Read the template content synchronously (safe in serverless functions)
        let template = fs.readFileSync(templatePath, 'utf8');

        // Dynamically generated content
        const orderTableRows = generateOrderTableRows(items);
        const orderDate = new Date(timestamp).toLocaleDateString('en-US', {
            year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC'
        });

        // Replace placeholders in the HTML template
        emailHtmlBody = template
            .replace('{{params.orderId}}', orderId)
            .replace('{{params.orderDate}}', orderDate)
            .replace('{{params.orderTableRows}}', orderTableRows)
            .replace('{{params.totalPrice}}', formatPrice(totalCents))
            .replace('{{contact.EMAIL}}', buyerEmail); // For the footer's sent-to line

    } catch (error) {
        console.error("Error loading or processing template:", error);
        // Log the exact error for debugging Netlify/FS issues
        if (error.code === 'ENOENT') {
            console.error(`File not found: ${path.join(__dirname, 'emailTemplates', 'orderConfirmationTemplate.html')}`);
        }
        return { statusCode: 500, body: JSON.stringify({ error: "Failed to generate email content from template. Check file path/existence." }) };
    }


    // --- 2. Brevo API Payload ---
    const brevoPayload = {
        sender: {
            name: "autoInx E-Commerce",
            email: "noreply@yourdomain.com" // IMPORTANT: Use a verified sender email in your Brevo account
        },
        to: [{ email: buyerEmail }],
        subject: `autoInx Order #${orderId.slice(0, 8)}... Confirmed!`,
        htmlContent: emailHtmlBody,
    };

    // --- 3. Call Brevo API ---
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
            body: JSON.stringify({ message: "Order processed and email sent successfully." })
        };

    } catch (error) {
        console.error("Critical error during Brevo fetch:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "Internal server error during email transaction." })
        };
    }
};
