/**
 * Netlify Function: send-email.js
 * Handles order confirmation emails to the customer and notification emails to the admin/requester.
 */
const nodemailer = require("nodemailer");
const fs = require("fs").promises;
const path = require("path");

// --- Configuration and Helpers (Unchanged) ---

// 1. Configure Nodemailer Transporter using Brevo SMTP details
const transporter = nodemailer.createTransport({
    host: process.env.BREVO_SMTP_HOST,
    port: process.env.BREVO_SMTP_PORT,
    secure: false,
    auth: {
        user: process.env.BREVO_SMTP_USER,
        pass: process.env.BREVO_SMTP_PASSWORD,
    },
});

// Helper to format cents to currency string ($X,XXX.XX)
function formatPrice(cents) {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2
    }).format(cents / 100);
}

// Load base HTML template
async function getTemplateHtml() {
    try {
        const templatePath = path.join(__dirname, "emailTemplates", "orderConfirmationTemplate.html");
        return await fs.readFile(templatePath, "utf8");
    } catch (error) {
        console.error("Error reading order confirmation template:", error);
        throw new Error("Failed to load email template");
    }
}

// Generate HTML rows for the order items table
function generateTableRows(items) {
    return items.map(item => {
        const subtotal = item.price * item.quantity;
        return `
            <tr>
                <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: left; font-size: 14px;">${item.name} (${item.sku || 'N/A'})</td>
                <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: right; font-size: 14px;">${item.quantity}</td>
                <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: right; font-size: 14px;">${formatPrice(item.price)}</td>
                <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: right; font-size: 14px;">${formatPrice(subtotal)}</td>
            </tr>
        `;
    }).join('');
}

/**
 * Populates the order template with dynamic content.
 * @param {object} orderData - The complete order object.
 * @param {string} recipientType - 'customer' or 'admin'
 */
async function populateTemplate(orderData, recipientType) {
    let template = await getTemplateHtml();

    const orderDate = new Date(orderData.timestamp).toLocaleDateString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
    
    // 1. Generate dynamic content
    const tableRows = generateTableRows(orderData.items);
    const totalPrice = formatPrice(orderData.totalCents);
    
    let subjectLine;
    let introText;
    let recipientEmailPlaceholder;

    if (recipientType === 'customer') {
        subjectLine = "Your autoInx Order is Confirmed";
        introText = `Hello ${orderData.buyerName}, thank you for your purchase! We've received your order and are preparing your items for delivery.`;
        recipientEmailPlaceholder = orderData.buyerEmail;
    } else { // admin notification or requester copy
        subjectLine = `NEW ORDER #${orderData.orderId.substring(0, 8).toUpperCase()} - ${orderData.buyerName}`;
        introText = `A new order has been placed on the site. Please review the details below.`;
        recipientEmailPlaceholder = 'orders@autoinx.com'; // Default for template footer
    }

    // 2. Perform replacements
    template = template.replace(/Your autoInx Order is Confirmed/g, subjectLine);
    template = template.replace(/Hello, thank you for your purchase![\s\S]*?<\/p>/, `<p style="margin-bottom: 20px; font-size: 16px;">${introText}</p>`);
    
    template = template.replace(/{{params\.orderId}}/g, orderData.orderId);
    template = template.replace(/{{params\.orderDate}}/g, orderDate);
    template = template.replace(/{{params\.orderTableRows}}/g, tableRows);
    template = template.replace(/{{params\.totalPrice}}/g, totalPrice);
    
    // Brevo email placeholder in footer (use the actual recipient email)
    template = template.replace(/{{contact\.EMAIL}}/g, recipientEmailPlaceholder);

    // Optional: Add Delivery/Shipping Info (for Admin/Requester)
    if (recipientType !== 'customer') {
        const adminDetails = `
            <p style="margin-top: 30px; border-top: 1px solid #ddd; padding-top: 15px; font-size: 14px; color: #3b3f44;">
                <strong>Customer Name:</strong> ${orderData.buyerName}<br>
                <strong>Delivery Address:</strong> ${orderData.deliveryAddress}<br>
                <strong>Phone (WhatsApp Opt-in: ${orderData.prefersWhatsapp ? 'YES' : 'NO'}):</strong> ${orderData.buyerPhone}<br>
                ${orderData.geolocation ? `<strong>Coordinates:</strong> Lat ${orderData.geolocation.lat}, Lng ${orderData.geolocation.lng}<br>` : ''}
            </p>
            <p style="margin-bottom: 20px; font-size: 14px; color: #3b3f44;">
                Order created via: ${orderData.adminEmail || 'Public Checkout'}
            </p>
            <div style="border-top: 1px solid #ddd;"></div>
        `;
        // Inject admin details right above the order items table, after Order Date
        template = template.replace(/<\/p>\s*/, `</p>${adminDetails}`);
    }


    return { html: template, subject: subjectLine };
}

// --- Netlify Handler ---

exports.handler = async function (event) {
    if (event.httpMethod !== "POST") {
        return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
    }

    const orderData = JSON.parse(event.body);
    // Destructure all necessary fields, including the new optional requesterEmail
    const { orderId, buyerEmail, items, totalCents, requesterEmail } = orderData;
    
    // Basic Validation Check
    if (!orderId || !buyerEmail || !items || items.length === 0 || totalCents === undefined) {
        return { statusCode: 400, body: JSON.stringify({ error: "Missing required order data for email processing." }) };
    }

    try {
        // --- 1. Customer Confirmation Email ---
        const customerEmailData = await populateTemplate(orderData, 'customer');

        const customerMailOptions = {
            from: "noreply@autoinx.com", 
            to: buyerEmail,
            subject: customerEmailData.subject,
            html: customerEmailData.html,
        };
        await transporter.sendMail(customerMailOptions);


        // --- 2. Admin Notification Email (to main orders mailbox) ---
        const adminEmailData = await populateTemplate(orderData, 'admin');

        const adminMailOptions = {
            from: "noreply@autoinx.com", 
            to: "orders@autoinx.com", // Dedicated orders email
            subject: adminEmailData.subject,
            html: adminEmailData.html,
        };
        await transporter.sendMail(adminMailOptions);
        
        // --- 3. Requester/Sales Agent Notification Email (NEW) ---
        if (requesterEmail && requesterEmail !== buyerEmail && requesterEmail !== "orders@autoinx.com") {
             // Re-use the admin email data since it contains the order details
            const requesterMailOptions = {
                from: "noreply@autoinx.com", 
                to: requesterEmail,
                // Optionally modify the subject to clarify this is a copy
                subject: `[COPY] ${adminEmailData.subject}`,
                html: adminEmailData.html,
            };
            await transporter.sendMail(requesterMailOptions);
            console.log(`Sent order copy to requester: ${requesterEmail}`);
        }


        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: "Emails sent successfully to customer, admin, and optional requester.", orderId }),
        };

    } catch (error) {
        console.error(`Failed to send order emails for order ${orderId}:`, error);
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: "Failed to send order emails.", details: error.message }),
        };
    }
};
