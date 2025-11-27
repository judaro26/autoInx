/**
 * Netlify Function: send-email.js
 * Handles order confirmation emails (initial) and status update notifications (Processing, Delivered, Cancelled).
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
 * MODIFIED to handle 'newStatus' for notifications.
 * @param {object} orderData - The complete order object.
 * @param {string} recipientType - 'customer' or 'admin'
 */
async function populateTemplate(orderData, recipientType) {
    let template = await getTemplateHtml();

    const orderDate = new Date(orderData.timestamp).toLocaleDateString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
    
    // NEW: Extract status. Default to 'Confirmed' if not a status update
    const orderStatus = orderData.newStatus || 'Confirmed'; 
    const orderIdShort = orderData.orderId.substring(0, 5);

    // Dynamic Variables for Template Injection
    let mainTitle;
    let mainIntro;
    let badgeText;
    let badgeColor;
    let closeMessage;
    let subjectLine;
    
    // 1. Generate dynamic content
    const tableRows = generateTableRows(orderData.items);
    const totalPrice = formatPrice(orderData.totalCents);
    
    // 2. Determine content based on recipient and status
    if (recipientType === 'customer') {
        switch (orderStatus) {
            case 'Confirmed':
            case 'Manually Created':
                subjectLine = "Your autoInx Order is Confirmed";
                mainTitle = "Thank you for your order!";
                mainIntro = `We’ve received your order and are getting it ready to ship.`;
                badgeText = "✓ Order Confirmed";
                badgeColor = "#10b981"; // Green
                closeMessage = `You’ll receive another email when your order ships. Questions? Reply to this email — we’re here to help!`;
                break;
            case 'Processing':
                subjectLine = `Update: Your autoInx Order is Now Processing`;
                mainTitle = "Your Order is on its Way!";
                mainIntro = `Your order #${orderIdShort} is now processing. We will notify you when it is out for delivery.`;
                badgeText = "→ Now Processing";
                badgeColor = "#6366f1"; // Indigo/Blue
                closeMessage = `Track your order's progress online or reply to this email with any questions.`;
                break;
            case 'Delivered':
                subjectLine = `Order Delivered: Thank you for shopping with autoInx!`;
                mainTitle = "Order Delivered!";
                mainIntro = `Your order #${orderIdShort} has been successfully delivered. We appreciate your business.`;
                badgeText = "🎉 Order Delivered";
                badgeColor = "#3b82f6"; // Blue
                closeMessage = `We hope you love your new parts! If you need anything else, please contact us.`;
                break;
            case 'Cancelled':
                subjectLine = `Order Update: Your autoInx Order Has Been Cancelled`;
                mainTitle = "Order Cancelled";
                mainIntro = `Your order #${orderIdShort} has been cancelled per your request or due to an issue.`;
                badgeText = "✗ Order Cancelled";
                badgeColor = "#ef4444"; // Red
                closeMessage = `If this was an error, please reply immediately or create a new order.`;
                break;
            default: // Fallback
                subjectLine = "Order Status Update";
                mainTitle = `Status: ${orderStatus}`;
                mainIntro = `Your order #${orderIdShort} status has been updated to ${orderStatus}.`;
                badgeText = `Status: ${orderStatus}`;
                badgeColor = "#64748b";
        }
        recipientEmailPlaceholder = orderData.buyerEmail;

    } else { // admin notification or requester copy
        subjectLine = orderStatus === 'Confirmed' 
            ? `NEW ORDER #${orderData.orderId.substring(0, 8).toUpperCase()} - ${orderData.buyerName}`
            : `STATUS UPDATE [${orderStatus}]: Order #${orderIdShort} - ${orderData.buyerName}`;
            
        mainTitle = subjectLine;
        mainIntro = orderStatus === 'Confirmed' 
            ? `A new order has been placed on the site.`
            : `Order status has been manually updated to **${orderStatus}**.`;
        badgeText = orderStatus;
        badgeColor = "#6366f1"; 
        closeMessage = 'Internal admin copy. This notification confirms the status change.';
        recipientEmailPlaceholder = 'orders@autoinx.com';
    }

    // 3. Perform replacements on the template
    // Note: The template must have placeholders for {{params.badgeColor}}, {{params.badgeText}}, etc.
    template = template.replace(/{{params\.badgeColor}}/g, badgeColor); 
    template = template.replace(/{{params\.badgeText}}/g, badgeText); 
    template = template.replace(/{{params\.mainTitle}}/g, mainTitle); 
    template = template.replace(/{{params\.mainIntro}}/g, mainIntro); 
    template = template.replace(/{{params\.closeMessage}}/g, closeMessage);
    
    // Existing replacements:
    template = template.replace(/{{params\.orderId}}/g, orderData.orderId);
    template = template.replace(/{{params\.orderDate}}/g, orderDate);
    template = template.replace(/{{params\.orderTableRows}}/g, tableRows);
    template = template.replace(/{{params\.totalPrice}}/g, totalPrice);
    template = template.replace(/{{params\.orderStatus}}/g, orderStatus); // New status row in table
    
    // Final Template Cleanup (Replacing intro text placeholder to clean up surrounding tags)
    // NOTE: This relies on the template HTML being clean. 
    template = template.replace(/Thank you for your order![\s\S]*?<\/p>/, `${mainTitle}</p><p style="margin:12px 0 0; font-size:17px; color:#64748b; line-height:1.6;">${mainIntro}</p>`);
    
    // Brevo email placeholder in footer 
    template = template.replace(/{{contact\.EMAIL}}/g, recipientEmailPlaceholder);

    // Optional: Add Delivery/Shipping Info (for Admin/Requester)
    if (recipientType !== 'customer') {
        const adminDetails = `
            <p style="margin-top: 30px; border-top: 1px solid #ddd; padding-top: 15px; font-size: 14px; color: #3b3f44;">
                <strong>Order Status:</strong> ${orderStatus}<br>
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
    // MODIFIED: Destructure newStatus from the payload
    const { orderId, buyerEmail, items, totalCents, requesterEmail, newStatus } = orderData; 
    
    // Basic Validation Check
    if (!orderId || !buyerEmail || !items || items.length === 0 || totalCents === undefined) {
        return { statusCode: 400, body: JSON.stringify({ error: "Missing required order data for email processing." }) };
    }

    try {
        // --- 1. Customer Email (ISOLATED FOR DEBUGGING SILENT FAILURES) ---
        const customerEmailData = await populateTemplate({ ...orderData, newStatus }, 'customer'); 

        const customerMailOptions = {
            from: "noreply@autoinx.com", 
            to: buyerEmail,
            subject: customerEmailData.subject,
            html: customerEmailData.html,
        };
        
        try {
            await transporter.sendMail(customerMailOptions);
            console.log(`Successfully sent email to customer: ${buyerEmail}`);
        } catch (customerSendError) {
            console.error(`CRITICAL FAILURE: Failed to send email to customer ${buyerEmail}. This is the likely cause of your previous issue.`, customerSendError);
            // We continue the function execution to try and send admin emails, but report the failure.
        }

        // --- 2. Admin Notification Email (to main orders mailbox) ---
        const adminEmailData = await populateTemplate({ ...orderData, newStatus }, 'admin'); // Pass newStatus

        const adminMailOptions = {
            from: "noreply@autoinx.com", 
            to: "orders@autoinx.com", // Dedicated orders email
            subject: adminEmailData.subject,
            html: adminEmailData.html,
        };
        await transporter.sendMail(adminMailOptions);
        
        // --- 3. Requester/Sales Agent Notification Email (NEW) ---
        if (requesterEmail && requesterEmail !== buyerEmail && requesterEmail !== "orders@autoinx.com") {
            const requesterEmailData = await populateTemplate({ ...orderData, newStatus }, 'admin'); // Pass newStatus
            
            const requesterMailOptions = {
                from: "noreply@autoinx.com", 
                to: requesterEmail,
                subject: `[COPY] ${adminEmailData.subject}`,
                html: adminEmailData.html,
            };
            await transporter.sendMail(requesterMailOptions);
            console.log(`Sent order copy to requester: ${requesterEmail}`);
        }

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: "Emails sent successfully to admin(s) and potentially customer.", orderId }),
        };

    } catch (error) {
        console.error(`Failed to execute email function for order ${orderId}:`, error);
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: "Failed to execute email function.", details: error.message }),
        };
    }
};
