/**
 * Netlify Function (AWS Lambda) to securely send an order confirmation email via Brevo (Sendinblue).
 *
 * IMPORTANT: Deploy this file to Netlify under the path /.netlify/functions/send-email.
 * The Brevo API Key must be set in Netlify's environment variables as BREVO_API_KEY.
 */

const fetch = require('node-fetch');

// Helper to format price from cents to a currency string
const formatPrice = (priceInCents) => `$${(priceInCents / 100).toFixed(2)}`;

exports.handler = async (event, context) => {
    // Check for POST method and existence of API key
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

    const { buyerEmail, items, totalCents, orderId } = order;

    if (!buyerEmail || !items || !totalCents || !orderId) {
        return { statusCode: 400, body: JSON.stringify({ message: "Missing required order details (email, items, total, or orderId)." }) };
    }

    // --- 1. Construct the Email Content ---
    let itemHtmlList = items.map(item => `
        <tr>
            <td style="padding: 8px; border: 1px solid #ddd;">${item.name}</td>
            <td style="padding: 8px; border: 1px solid #ddd; text-align: right;">${item.quantity}</td>
            <td style="padding: 8px; border: 1px solid #ddd; text-align: right;">${formatPrice(item.price)}</td>
            <td style="padding: 8px; border: 1px solid #ddd; text-align: right;">${formatPrice(item.price * item.quantity)}</td>
        </tr>
    `).join('');

    const emailHtmlBody = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; border: 1px solid #eee; padding: 20px; border-radius: 8px;">
            <h2 style="color: #6366f1;">Order Confirmation: #${orderId}</h2>
            <p>Thank you for your order! Your purchase details are below:</p>
            
            <p><strong>Order ID:</strong> #${orderId}</p>
            <p><strong>Billed To:</strong> ${buyerEmail}</p>

            <table style="width: 100%; border-collapse: collapse; margin-top: 20px;">
                <thead>
                    <tr style="background-color: #f3f4f6;">
                        <th style="padding: 12px; border: 1px solid #ddd; text-align: left;">Item</th>
                        <th style="padding: 12px; border: 1px solid #ddd; text-align: right;">Qty</th>
                        <th style="padding: 12px; border: 1px solid #ddd; text-align: right;">Unit Price</th>
                        <th style="padding: 12px; border: 1px solid #ddd; text-align: right;">Subtotal</th>
                    </tr>
                </thead>
                <tbody>
                    ${itemHtmlList}
                </tbody>
                <tfoot>
                    <tr>
                        <td colspan="3" style="padding: 12px; text-align: right; font-weight: bold; border-top: 2px solid #6366f1;">Total:</td>
                        <td style="padding: 12px; text-align: right; font-weight: bold; color: #6366f1; border-top: 2px solid #6366f1;">${formatPrice(totalCents)}</td>
                    </tr>
                </tfoot>
            </table>

            <p style="margin-top: 30px; font-size: 0.9em; color: #6b7280;">
                You are receiving this email because you placed an order with our store.
            </p>
        </div>
    `;

    // --- 2. Brevo API Payload ---
    const brevoPayload = {
        sender: {
            name: "Your Store Name",
            email: "noreply@yourdomain.com" // Use a verified sender email
        },
        to: [{ email: buyerEmail }],
        subject: `Your Order Confirmation (#${orderId})`,
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
            body: JSON.stringify({ message: "Internal server error during email transaction." })
        };
    }
};
