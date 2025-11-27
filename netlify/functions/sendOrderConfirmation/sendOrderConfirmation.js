/**
 * Netlify Function: send-email.js
 * Handles order confirmation (initial) and status update notifications,
 * dynamically selecting the template based on the 'language' property.
 */
const nodemailer = require("nodemailer");
const fs = require("fs").promises;
const path = require("path");

// --- Configuration and Helpers ---

// 1. Configure Nodemailer Transporter
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

// MODIFIED: Load base HTML template based on language code
async function getTemplateHtml(languageCode) {
    let filename = (languageCode === 'es') 
        ? "orderConfirmationTemplateSpanish.html" 
        : "orderConfirmationTemplate.html";
        
    try {
        const templatePath = path.join(__dirname, "emailTemplates", filename);
        return await fs.readFile(templatePath, "utf8");
    } catch (error) {
        console.error(`Error reading email template for ${languageCode}: ${filename}`, error);
        // Fallback gracefully to English if the localized template file is missing
        if (languageCode !== 'en') {
             console.warn("Falling back to English template.");
             return getTemplateHtml('en'); 
        }
        throw new Error(`Failed to load email template: ${filename}`);
    }
}

// Generate HTML rows for the order items table
function generateTableRows(items, languageCode) {
    // NOTE: You would ideally internationalize the column headers (Item, Qty, Unit Price) 
    // inside the template file itself, not here.
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
 * @param {object} orderData - The complete order object, including 'newStatus' and 'language'.
 */
async function populateTemplate(orderData, recipientType) {
    const languageCode = orderData.language || 'en';
    const orderStatus = orderData.newStatus || 'Confirmed'; 
    const orderIdShort = orderData.orderId.substring(0, 5);

    // FIX: Load template based on language
    let template = await getTemplateHtml(languageCode); 

    // Dynamic Variables for Template Injection
    // NOTE: Subject, Titles, and Intro text should ideally be handled by a translation utility 
    // but are hardcoded here for simplicity based on the language.
    let mainTitle;
    let mainIntro;
    let badgeText;
    let badgeColor;
    let closeMessage;
    let subjectLine;

    // --- Dynamic Content Calculation ---
    // (This logic needs to be manually translated based on languageCode)
    if (languageCode === 'es') {
        if (orderStatus === 'Confirmed') {
            subjectLine = "Su pedido autoInx ha sido Confirmado";
            mainTitle = "¡Gracias por su pedido!";
            mainIntro = `Hola ${orderData.buyerName}, hemos recibido su pedido y estamos preparando sus artículos para el envío.`;
            badgeText = "✓ Pedido Confirmado";
            badgeColor = "#10b981"; // Green
            closeMessage = `Recibirá otro correo cuando su pedido sea enviado. ¿Preguntas? Responda a este correo—¡estamos aquí para ayudar!`;
        } else if (orderStatus === 'Cancelled') {
            subjectLine = "Actualización: Su Pedido autoInx ha sido Cancelado";
            mainTitle = "Pedido Cancelado";
            mainIntro = `Su pedido #${orderIdShort} ha sido cancelado. Contacte a soporte si tiene preguntas.`;
            badgeText = "✗ Pedido Cancelado";
            badgeColor = "#ef4444"; // Red
            closeMessage = `Si fue un error, responda inmediatamente o cree un nuevo pedido.`;
        } else {
             subjectLine = `Actualización: Su Pedido ahora es ${orderStatus}`;
             mainTitle = `Estado: ${orderStatus}`;
             mainIntro = `Hola ${orderData.buyerName}, el estado de su pedido #${orderIdShort} ahora es **${orderStatus}**.`;
             badgeText = `Estado: ${orderStatus}`;
             badgeColor = "#6366f1";
        }
    } else { // English (en)
        if (orderStatus === 'Confirmed') {
            subjectLine = "Your autoInx Order is Confirmed";
            mainTitle = "Thank you for your order!";
            mainIntro = `Hello ${orderData.buyerName}, we've received your order and are getting it ready to ship.`;
            badgeText = "✓ Order Confirmed";
            badgeColor = "#10b981"; 
            closeMessage = `You’ll receive another email when your order ships. Questions? Reply to this email — we’re here to help!`;
        } else if (orderStatus === 'Cancelled') {
            subjectLine = "Update: Your autoInx Order Has Been Cancelled";
            mainTitle = "Order Cancelled";
            mainIntro = `Your order #${orderIdShort} has been cancelled per your request or due to an issue.`;
            badgeText = "✗ Order Cancelled";
            badgeColor = "#ef4444"; 
            closeMessage = `If this was an error, please reply immediately or create a new order.`;
        } else {
             subjectLine = `Update: Your autoInx Order is Now ${orderStatus}`;
             mainTitle = `Your Order is Now ${orderStatus}!`;
             mainIntro = `Hello ${orderData.buyerName}, the status of your order #${orderIdShort} is now **${orderStatus}**.`;
             badgeText = `Status: ${orderStatus}`;
             badgeColor = "#6366f1";
        }
    }

    // Admin subject logic override
    if (recipientType !== 'customer') {
        subjectLine = orderStatus === 'Confirmed' 
            ? `NEW ORDER #${orderData.orderId.substring(0, 8).toUpperCase()} - ${orderData.buyerName}`
            : `STATUS UPDATE [${orderStatus}]: Order #${orderIdShort} - ${orderData.buyerName}`;
        mainTitle = subjectLine;
        mainIntro = "Internal notification. Please process this order.";
        closeMessage = 'Internal admin copy.';
    }

    recipientEmailPlaceholder = orderData.buyerEmail; // Default recipient email

    // 4. Perform replacements on the template (Ensure your template has these exact placeholders)
    template = template.replace(/{{params\.badgeColor}}/g, badgeColor); 
    template = template.replace(/{{params\.badgeText}}/g, badgeText); 
    template = template.replace(/{{params\.mainTitle}}/g, mainTitle); 
    template = template.replace(/{{params\.mainIntro}}/g, mainIntro); 
    template = template.replace(/{{params\.closeMessage}}/g, closeMessage);
    
    // Existing replacements:
    template = template.replace(/{{params\.orderId}}/g, orderData.orderId);
    template = template.replace(/{{params\.orderDate}}/g, new Date(orderData.timestamp).toLocaleDateString(languageCode === 'es' ? 'es-ES' : 'en-US', {
        year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    }));
    template = template.replace(/{{params\.orderTableRows}}/g, generateTableRows(orderData.items));
    template = template.replace(/{{params\.totalPrice}}/g, formatPrice(orderData.totalCents));
    template = template.replace(/{{params\.orderStatus}}/g, orderStatus);
    
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
    const { orderId, buyerEmail, items, totalCents, requesterEmail, newStatus, language } = orderData; 
    
    // Basic Validation Check
    if (!orderId || !buyerEmail || !items || items.length === 0 || totalCents === undefined) {
        return { statusCode: 400, body: JSON.stringify({ error: "Missing required order data for email processing." }) };
    }

    try {
        // --- 1. Customer Email (Pass language and status) ---
        const customerEmailData = await populateTemplate({ ...orderData, newStatus, language }, 'customer'); 

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
            console.error(`CRITICAL FAILURE: Failed to send email to customer ${buyerEmail}.`, customerSendError);
        }

        // --- 2. Admin Notification Email (Force English for Admin Copy) ---
        const adminEmailData = await populateTemplate({ ...orderData, newStatus, language: 'en' }, 'admin'); // Force 'en'

        const adminMailOptions = {
            from: "noreply@autoinx.com", 
            to: "orders@autoinx.com", // Dedicated orders email
            subject: adminEmailData.subject,
            html: adminEmailData.html,
        };
        await transporter.sendMail(adminMailOptions);
        
        // --- 3. Requester/Sales Agent Notification Email ---
        if (requesterEmail && requesterEmail !== buyerEmail && requesterEmail !== "orders@autoinx.com") {
            const requesterEmailData = await populateTemplate({ ...orderData, newStatus, language: 'en' }, 'admin'); // Force 'en'
            
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
