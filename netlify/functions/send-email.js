/**
 * Netlify Function (AWS Lambda) to securely send an order confirmation email via Brevo (Sendinblue) API.
 *
 * NOTE: This is adapted to use the Brevo API directly via fetch, as it is cleaner than
 * using nodemailer/smtp setup for simple transactional emails in a serverless environment.
 * The Brevo API Key must be set in Netlify's environment variables as BREVO_API_KEY.
 */

const fetch = require('node-fetch');

// Helper to format price from cents to a currency string
const formatPrice = (priceInCents) => `$${(priceInCents / 100).toFixed(2)}`;

// Helper to generate the HTML table for the order items
const generateOrderTable = (items, totalCents) => {
    let itemHtmlList = items.map(entry => `
        <tr>
            <td style="padding: 8px; border: 1px solid #ddd;">${entry.name}</td>
            <td style="padding: 8px; border: 1px solid #ddd; text-align: right;">${entry.quantity}</td>
            <td style="padding: 8px; border: 1px solid #ddd; text-align: right;">${formatPrice(entry.price)}</td>
            <td style="padding: 8px; border: 1px solid #ddd; text-align: right;">${formatPrice(entry.price * entry.quantity)}</td>
        </tr>
    `).join('');

    return `
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
    `;
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

    const { buyerEmail, items, totalCents, orderId } = order;

    if (!buyerEmail || !items || !totalCents || !orderId) {
        return { statusCode: 400, body: JSON.stringify({ message: "Missing required order details (email, items, total, or orderId)." }) };
    }

    // 1. Generate Email HTML Content
    const orderTableHtml = generateOrderTable(items, totalCents);

    const emailHtmlBody = `
        <div style="font-family: 'Inter', Arial, sans-serif; max-width: 600px; margin: auto; border: 1px solid #eee; padding: 20px; border-radius: 8px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
            <h2 style="color: #6366f1; border-bottom: 2px solid #6366f1; padding-bottom: 10px;">Order Confirmation: #${orderId.slice(0, 8)}...</h2>
            <p style="margin-bottom: 20px;">Thank you for your purchase! Your order details are below:</p>
            
            <p><strong>Order ID:</strong> ${orderId}</p>
            <p><strong>Recipient:</strong> ${buyerEmail}</p>

            ${orderTableHtml}

            <p style="margin-top: 30px; font-size: 0.9em; color: #6b7280;">
                We will notify you again when your order ships.
            </p>
        </div>
    `;

    // 2. Brevo API Payload
    const brevoPayload = {
        sender: {
            name: "Your E-Commerce Store",
            email: "noreply@yourdomain.com" // IMPORTANT: Use a verified sender email in your Brevo account
        },
        to: [{ email: buyerEmail }],
        subject: `Order #${orderId.slice(0, 8)}... Confirmed!`,
        htmlContent: emailHtmlBody,
    };

    // 3. Call Brevo API
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
