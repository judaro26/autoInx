/**
 * Netlify Function: sendOrderConfirmation.js
 * Handles Email Notifications for New Orders & Status Updates with Shipping/Tax Breakdown.
 */
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const fs = require("fs").promises;
const path = require("path");

// --- 1. Global Rate Limiting ---
const rateLimitStore = {}; 
const MAX_REQUESTS_PER_HOUR = 30;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

// --- 2. Firebase Admin Initialization ---
function getDb() {
    if (admin.apps.length === 0) {
        try {
            const serviceAccount = {
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            };

            if (!serviceAccount.projectId || !serviceAccount.privateKey) {
                throw new Error("Missing critical Firebase environment variables.");
            }

            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount),
                databaseURL: process.env.FIREBASE_DATABASE_URL
            });
            console.log("Firebase Admin Initialized.");
        } catch (error) {
            console.error("Firebase Admin initialization failed:", error);
            throw error;
        }
    }
    return admin.firestore();
}

// --- 3. Transporter Configuration (SMTP) ---
const transporter = nodemailer.createTransport({
    host: process.env.BREVO_SMTP_HOST,
    port: process.env.BREVO_SMTP_PORT,
    secure: false,
    auth: {
        user: process.env.BREVO_SMTP_USER,
        pass: process.env.BREVO_SMTP_PASSWORD,
    },
});

// --- 4. Helpers ---
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
        const templatePath = path.resolve(__dirname, "emailTemplates", filename);
        return await fs.readFile(templatePath, "utf8");
    } catch (error) {
        console.warn(`Template ${filename} not found, falling back to English.`);
        const fallbackPath = path.resolve(__dirname, "emailTemplates", "orderConfirmationTemplate.html");
        return await fs.readFile(fallbackPath, "utf8");
    }
}

function generateTableRows(items) {
    return items.map(item => `
        <tr>
            <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: left; font-size: 14px;">${item.name}</td>
            <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: right; font-size: 14px;">${item.quantity}</td>
            <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: right; font-size: 14px;">${formatPrice(item.price)}</td>
            <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: right; font-size: 14px;">${formatPrice(item.price * item.quantity)}</td>
        </tr>`).join('');
}

// ✅ NEW: Generate cost breakdown section with shipping and tax
function generateCostBreakdown(orderData, languageCode) {
    // Handle both new orders (with breakdown) and old orders (without breakdown)
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

    // ✅ Only show shipping row if shipping cost exists
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

    // ✅ Only show tax row if tax cost exists
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

    // ✅ Total row - always shown
    breakdownHtml += `
        <tr style="border-top: 2px solid #4f46e5; background-color: #f9fafb;">
            <td colspan="3" style="padding: 16px; text-align: right; font-size: 18px; font-weight: bold; color: #1f2937;">${labels.total}:</td>
            <td style="padding: 16px; text-align: right; font-size: 18px; font-weight: bold; color: #4f46e5;">${formatPrice(totalCents)}</td>
        </tr>
    `;

    return breakdownHtml;
}

// --- 5. Main Handler ---
exports.handler = async function (event) {
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
        const orderData = JSON.parse(event.body);
        const { 
            orderId, 
            buyerEmail, 
            buyerName, 
            items, 
            totalCents,
            subtotalCents,      // ✅ NEW
            shippingCents,      // ✅ NEW
            taxCents,           // ✅ NEW
            shippingDetails,    // ✅ NEW
            taxDetails,         // ✅ NEW
            communicationLang, 
            appId, 
            paymentUrl,
            newStatus 
        } = orderData;

        // Ensure DB is initialized
        getDb();

        console.log('📧 Processing email for order:', {
            orderId: orderId?.substring(0, 8),
            isStatusUpdate: !!newStatus,
            hasBreakdown: !!(subtotalCents || shippingCents || taxCents),
            subtotal: subtotalCents ? formatPrice(subtotalCents) : 'N/A',
            shipping: shippingCents ? formatPrice(shippingCents) : '$0.00',
            tax: taxCents ? formatPrice(taxCents) : '$0.00',
            total: formatPrice(totalCents)
        });

        // STEP 1: Prepare Email Content Logic
        const languageCode = communicationLang || 'en';
        let template = await getTemplateHtml(languageCode);

        // Status Configuration for Styling
        const statusConfig = {
            'Pending': { color: "#ef4444", en: "Pending", es: "Pendiente" },
            'Processing': { color: "#3b82f6", en: "Processing", es: "Procesando" },
            'Shipped': { color: "#8b5cf6", en: "Shipped", es: "Enviado" },
            'Delivered': { color: "#10b981", en: "Delivered", es: "Entregado" },
            'Cancelled': { color: "#64748b", en: "Cancelled", es: "Cancelado" }
        };

        const isStatusUpdate = !!newStatus;
        const currentStatus = newStatus || "Pending";
        const config = statusConfig[currentStatus] || statusConfig['Pending'];
        const badgeColor = config.color;
        const statusText = languageCode === 'es' ? config.es : config.en;

        let badgeLabel, mainTitle, mainIntro, closeMsg;

        if (isStatusUpdate) {
            badgeLabel = languageCode === 'es' ? `Actualización: ${statusText}` : `Update: ${statusText}`;
            mainTitle = languageCode === 'es' ? "Actualización de su Pedido" : "Order Status Update";
            mainIntro = languageCode === 'es' 
                ? `Hola ${buyerName}, el estado de su pedido #${orderId.substring(0, 8)} ha cambiado a: <strong>${statusText}</strong>.`
                : `Hello ${buyerName}, the status of your order #${orderId.substring(0, 8)} has been updated to: <strong>${statusText}</strong>.`;
            closeMsg = languageCode === 'es' ? "Le avisaremos cuando haya más novedades." : "We will notify you of further updates.";
        } else {
            badgeLabel = languageCode === 'es' ? "✓ Pedido Confirmado" : "✓ Order Confirmed";
            mainTitle = languageCode === 'es' ? "¡Gracias por su pedido!" : "Thank you for your order!";
            mainIntro = languageCode === 'es' 
                ? `Hola ${buyerName}, hemos recibido su pedido #${orderId.substring(0, 8)}.` 
                : `Hello ${buyerName}, we've received your order #${orderId.substring(0, 8)}.`;
            closeMsg = languageCode === 'es' ? "¡Gracias por elegir autoInx!" : "Thanks for choosing autoInx!";
        }

        // ✅ NEW: Generate cost breakdown with shipping and tax
        const costBreakdown = generateCostBreakdown(orderData, languageCode);

        // STEP 2: Replace placeholders in HTML
        template = template
            .replace(/{{params\.badgeColor}}/g, badgeColor)
            .replace(/{{params\.badgeText}}/g, badgeLabel)
            .replace(/{{params\.mainTitle}}/g, mainTitle)
            .replace(/{{params\.mainIntro}}/g, mainIntro)
            .replace(/{{params\.orderStatus}}/g, statusText)
            .replace(/{{params\.orderId}}/g, orderId)
            .replace(/{{params\.orderDate}}/g, new Date().toLocaleDateString())
            .replace(/{{params\.orderTableRows}}/g, generateTableRows(items))
            .replace(/{{params\.costBreakdown}}/g, costBreakdown)  // ✅ NEW
            .replace(/{{params\.totalPrice}}/g, formatPrice(totalCents))
            .replace(/{{params\.paymentUrl}}/g, paymentUrl || '')
            .replace(/{{params\.showPaymentButton}}/g, paymentUrl ? 'block' : 'none') 
            .replace(/{{params\.paymentButtonText}}/g, languageCode === 'es' ? `🔒 Pagar Ahora - ${formatPrice(totalCents)}` : `🔒 Pay Now - ${formatPrice(totalCents)}`)
            .replace(/{{params\.closeMessage}}/g, closeMsg)
            .replace(/{{contact\.EMAIL}}/g, buyerEmail);

        // STEP 3: Send Emails
        const subject = isStatusUpdate 
            ? (languageCode === 'es' ? `Actualización de Pedido #${orderId.substring(0,8)}` : `Order Update #${orderId.substring(0,8)}`)
            : (languageCode === 'es' ? "Confirmación de Pedido - autoInx" : "Order Confirmation - autoInx");

        const mailOptions = {
            from: '"autoInx Support" <noreply@autoinx.com>',
            to: buyerEmail,
            subject: subject,
            html: template
        };

        await transporter.sendMail(mailOptions);
        console.log('✅ Customer email sent to:', buyerEmail);
        
        // Internal log email (only for new orders, not status updates)
        if (!isStatusUpdate) {
            const internalSubject = `[NEW ORDER] #${orderId.substring(0,8)} - ${formatPrice(totalCents)}`;
            await transporter.sendMail({ 
                ...mailOptions, 
                to: "orders@autoinx.com", 
                subject: internalSubject
            });
            console.log('✅ Internal notification sent to orders@autoinx.com');
        }

        return {
            statusCode: 200,
            body: JSON.stringify({ 
                message: isStatusUpdate ? "Status update sent." : "Order confirmation sent.", 
                orderId,
                breakdown: {
                    subtotal: formatPrice(subtotalCents || totalCents),
                    shipping: formatPrice(shippingCents || 0),
                    tax: formatPrice(taxCents || 0),
                    total: formatPrice(totalCents)
                }
            })
        };

    } catch (error) {
        console.error("❌ Function Error:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "Email failure", details: error.message })
        };
    }
};
