/**
 * Netlify Function: sendStatusUpdate.js
 * Handles Email Notifications for Order Status Updates with full order details
 */
const nodemailer = require("nodemailer");
const fs = require("fs").promises;
const path = require("path");

// --- 1. Global Rate Limiting ---
const rateLimitStore = {}; 
const MAX_REQUESTS_PER_HOUR = 30;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

// --- 2. Transporter Configuration (SMTP) ---
const transporter = nodemailer.createTransport({
    host: process.env.BREVO_SMTP_HOST,
    port: process.env.BREVO_SMTP_PORT,
    secure: false,
    auth: {
        user: process.env.BREVO_SMTP_USER,
        pass: process.env.BREVO_SMTP_PASSWORD,
    },
});

// --- 3. Helpers ---
function formatPrice(cents) {
    return new Intl.NumberFormat('en-US', {
        style: 'currency', currency: 'USD', minimumFractionDigits: 2
    }).format(cents / 100);
}

async function getTemplateHtml(languageCode) {
    const filename = (languageCode === 'es') 
        ? "orderConfirmationTemplateSpanish.html" 
        : "orderConfirmationTemplate.html";
    
    try {
        // ✅ With included_files configured, templates will be in emailTemplates folder
        const templatePath = path.resolve(__dirname, "emailTemplates", filename);
        console.log('📂 Loading template from:', templatePath);
        
        const templateContent = await fs.readFile(templatePath, "utf8");
        console.log('✅ Template loaded successfully');
        return templateContent;
        
    } catch (error) {
        console.error(`❌ Failed to load template ${filename}:`, error.message);
        console.error('Available __dirname:', __dirname);
        
        // Try fallback to English
        if (languageCode === 'es') {
            console.log('⚠️ Falling back to English template...');
            try {
                const fallbackPath = path.resolve(__dirname, "emailTemplates", "orderConfirmationTemplate.html");
                return await fs.readFile(fallbackPath, "utf8");
            } catch (fallbackError) {
                console.error('❌ Fallback also failed:', fallbackError.message);
            }
        }
        
        throw new Error(`Could not load email template: ${filename}`);
    }
}

function generateTableRows(items) {
    return items.map(item => {
        const itemName = item.name || item.item?.name || 'Unknown Item';
        const itemPrice = item.price || item.item?.price || 0;
        const itemQuantity = item.quantity || 1;
        
        return `
        <tr>
            <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: left; font-size: 14px;">${itemName}</td>
            <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: right; font-size: 14px;">${itemQuantity}</td>
            <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: right; font-size: 14px;">${formatPrice(itemPrice)}</td>
            <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: right; font-size: 14px;">${formatPrice(itemPrice * itemQuantity)}</td>
        </tr>`;
    }).join('');
}

function generateCostBreakdown(orderData, languageCode) {
    const subtotalCents = orderData.subtotalCents || orderData.totalCents || 0;
    const shippingCents = orderData.shippingCents || 0;
    const taxCents = orderData.taxCents || 0;
    const totalCents = orderData.totalCents || 0;
    
    const labels = languageCode === 'es' 
        ? { subtotal: 'Subtotal', shipping: 'Envío', tax: 'Impuesto', total: 'TOTAL' }
        : { subtotal: 'Subtotal', shipping: 'Shipping', tax: 'Tax', total: 'TOTAL' };

    let breakdownHtml = `
        <tr style="border-top: 2px solid #e5e7eb;">
            <td colspan="3" style="padding: 12px; text-align: right; font-size: 14px; font-weight: 600; color: #374151;">${labels.subtotal}:</td>
            <td style="padding: 12px; text-align: right; font-size: 14px; font-weight: 600; color: #374151;">${formatPrice(subtotalCents)}</td>
        </tr>
    `;

    if (shippingCents > 0) {
        const shippingProvider = orderData.shippingDetails?.provider 
            ? ` (${orderData.shippingDetails.provider})` 
            : '';
        const estimatedDays = orderData.shippingDetails?.estimated_days
            ? ` - ${orderData.shippingDetails.estimated_days} days`
            : '';
        
        breakdownHtml += `
            <tr>
                <td colspan="3" style="padding: 12px; text-align: right; font-size: 14px; color: #6b7280;">
                    📦 ${labels.shipping}${shippingProvider}${estimatedDays}:
                </td>
                <td style="padding: 12px; text-align: right; font-size: 14px; color: #6b7280;">${formatPrice(shippingCents)}</td>
            </tr>
        `;
    }

    if (taxCents > 0) {
        const taxRate = orderData.taxDetails?.ratePercent 
            ? ` (${orderData.taxDetails.ratePercent}%)` 
            : '';
        
        breakdownHtml += `
            <tr>
                <td colspan="3" style="padding: 12px; text-align: right; font-size: 14px; color: #6b7280;">
                    📋 ${labels.tax}${taxRate}:
                </td>
                <td style="padding: 12px; text-align: right; font-size: 14px; color: #6b7280;">${formatPrice(taxCents)}</td>
            </tr>
        `;
    }

    breakdownHtml += `
        <tr style="border-top: 2px solid #4f46e5; background-color: #f9fafb;">
            <td colspan="3" style="padding: 16px; text-align: right; font-size: 18px; font-weight: bold; color: #1f2937;">${labels.total}:</td>
            <td style="padding: 16px; text-align: right; font-size: 18px; font-weight: bold; color: #4f46e5;">${formatPrice(totalCents)}</td>
        </tr>
    `;

    return breakdownHtml;
}

// --- 4. Main Handler ---
exports.handler = async function (event) {
    // 🔍 TEMPORARY DEBUG LOGGING
    console.log('=== PATH DEBUG INFO ===');
    console.log('__dirname:', __dirname);
    console.log('__filename:', __filename);
    console.log('process.cwd():', process.cwd());
    console.log('Template path would be:', path.resolve(__dirname, "sendOrderConfirmation", "emailTemplates", "orderConfirmationTemplate.html"));
    console.log('======================');
    
    if (event.httpMethod !== "POST") {
        return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
    }

    // Rate Limiting
    const clientIp = event.headers['client-ip'] || 'unknown';
    const now = Date.now();
    if (!rateLimitStore[clientIp]) rateLimitStore[clientIp] = [];
    rateLimitStore[clientIp] = rateLimitStore[clientIp].filter(t => t > now - RATE_LIMIT_WINDOW_MS);
    if (rateLimitStore[clientIp].length >= MAX_REQUESTS_PER_HOUR) {
        return { statusCode: 429, body: JSON.stringify({ error: "Rate limit exceeded." }) };
    }
    rateLimitStore[clientIp].push(now);

    try {
        const requestData = JSON.parse(event.body);
        const { 
            orderId,
            orderNumber,
            buyerEmail,
            buyerName,
            newStatus,
            oldStatus,
            language,
            items,
            totalCents,
            subtotalCents,
            shippingCents,
            taxCents,
            shippingDetails,
            taxDetails,
            orderDate
        } = requestData;

        // Validation
        if (!buyerEmail || !newStatus || !orderId) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Missing required fields: buyerEmail, newStatus, orderId' })
            };
        }

        console.log('📧 Processing status update email:', {
            orderId: orderId.substring(0, 8),
            oldStatus: oldStatus || 'N/A',
            newStatus: newStatus,
            email: buyerEmail,
            language: language || 'en'
        });

        const languageCode = language || 'en';
        let template = await getTemplateHtml(languageCode);

        // Status Configuration for Styling
        const statusConfig = {
            'Pending': { color: "#ef4444", en: "Pending", es: "Pendiente" },
            'Processing': { color: "#3b82f6", en: "Processing", es: "Procesando" },
            'Shipped': { color: "#8b5cf6", en: "Shipped", es: "Enviado" },
            'Delivered': { color: "#10b981", en: "Delivered", es: "Entregado" },
            'Cancelled': { color: "#64748b", en: "Cancelled", es: "Cancelado" }
        };

        const config = statusConfig[newStatus] || statusConfig['Pending'];
        const badgeColor = config.color;
        const statusText = languageCode === 'es' ? config.es : config.en;

        const badgeLabel = languageCode === 'es' 
            ? `Actualización: ${statusText}` 
            : `Update: ${statusText}`;
        
        const mainTitle = languageCode === 'es' 
            ? "Actualización de su Pedido" 
            : "Order Status Update";
        
        const mainIntro = languageCode === 'es' 
            ? `Hola ${buyerName}, el estado de su pedido #${orderNumber || orderId.substring(0, 8)} ha cambiado a: <strong>${statusText}</strong>.`
            : `Hello ${buyerName}, the status of your order #${orderNumber || orderId.substring(0, 8)} has been updated to: <strong>${statusText}</strong>.`;
        
        const closeMsg = languageCode === 'es' 
            ? "Le avisaremos cuando haya más novedades." 
            : "We will notify you of further updates.";

        // Generate cost breakdown if we have the data
        let costBreakdown = '';
        let orderTableRows = '';
        
        if (items && items.length > 0) {
            orderTableRows = generateTableRows(items);
            costBreakdown = generateCostBreakdown({
                subtotalCents,
                shippingCents,
                taxCents,
                totalCents,
                shippingDetails,
                taxDetails
            }, languageCode);
        } else {
            // Fallback if no items provided
            orderTableRows = '<tr><td colspan="4" style="padding: 12px; text-align: center; font-style: italic; color: #64748b;">Order details unavailable</td></tr>';
            costBreakdown = `
                <tr style="border-top: 2px solid #4f46e5; background-color: #f9fafb;">
                    <td colspan="3" style="padding: 16px; text-align: right; font-size: 18px; font-weight: bold; color: #1f2937;">TOTAL:</td>
                    <td style="padding: 16px; text-align: right; font-size: 18px; font-weight: bold; color: #4f46e5;">${formatPrice(totalCents || 0)}</td>
                </tr>
            `;
        }

        // Replace placeholders in template
        template = template
            .replace(/{{params\.badgeColor}}/g, badgeColor)
            .replace(/{{params\.badgeText}}/g, badgeLabel)
            .replace(/{{params\.mainTitle}}/g, mainTitle)
            .replace(/{{params\.mainIntro}}/g, mainIntro)
            .replace(/{{params\.orderStatus}}/g, statusText)
            .replace(/{{params\.orderId}}/g, orderNumber || orderId.substring(0, 8))
            .replace(/{{params\.orderDate}}/g, orderDate || new Date().toLocaleDateString())
            .replace(/{{params\.orderTableRows}}/g, orderTableRows)
            .replace(/{{params\.costBreakdown}}/g, costBreakdown)
            .replace(/{{params\.totalPrice}}/g, formatPrice(totalCents || 0))
            .replace(/{{params\.closeMessage}}/g, closeMsg)
            .replace(/{{contact\.EMAIL}}/g, buyerEmail);

        const subject = languageCode === 'es' 
            ? `Actualización de Pedido #${orderNumber || orderId.substring(0, 8)} - ${statusText}`
            : `Order Update #${orderNumber || orderId.substring(0, 8)} - ${statusText}`;

        const mailOptions = {
            from: '"autoInx Support" <noreply@autoinx.com>',
            to: buyerEmail,
            subject: subject,
            html: template
        };

        await transporter.sendMail(mailOptions);
        console.log('✅ Status update email sent to:', buyerEmail);

        return {
            statusCode: 200,
            body: JSON.stringify({ 
                success: true,
                message: 'Status update email sent successfully',
                orderId: orderId,
                status: newStatus
            })
        };

    } catch (error) {
        console.error("❌ Status Update Email Error:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ 
                error: "Failed to send status update email", 
                details: error.message 
            })
        };
    }
};
