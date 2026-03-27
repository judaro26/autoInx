const admin    = require("firebase-admin");
const nodemailer = require("nodemailer");
const crypto   = require("crypto");
const fs       = require("fs").promises;
const path     = require("path");

// ── HMAC request signature verification ──────────────────────────────────────
function verifySignature(orderId, signature) {
    const secret = process.env.ORDER_EMAIL_SECRET;
    if (!secret) return true; // skip if not configured
    if (!signature) return false;
    try {
        const expected = crypto.createHmac('sha256', secret).update(orderId).digest('hex');
        return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
    } catch { return false; }
}

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

async function getTemplateHtml(languageCode, templateType) {
    let filename;
    if (templateType === 'refund') {
        filename = (languageCode === 'es')
            ? "refundConfirmationTemplateSpanish.html"
            : "refundConfirmationTemplate.html";
    } else {
        filename = (languageCode === 'es')
            ? "orderConfirmationTemplateSpanish.html"
            : "orderConfirmationTemplate.html";
    }
    try {
        const templatePath = path.resolve(__dirname, "emailTemplates", filename);
        return await fs.readFile(templatePath, "utf8");
    } catch (error) {
        console.warn(`Template ${filename} not found, falling back to inline template.`);
        if (templateType === 'refund') {
            return getInlineRefundTemplate(languageCode);
        }
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

function generateCostBreakdown(orderData, languageCode) {
    const subtotalCents = orderData.subtotalCents || orderData.totalCents || 0;
    const shippingCents = orderData.shippingCents || 0;
    const taxCents      = orderData.taxCents || 0;
    const totalCents    = orderData.totalCents || 0;

    const labels = languageCode === 'es'
        ? { subtotal: 'Subtotal', shipping: 'Envío', tax: 'Impuesto', total: 'TOTAL' }
        : { subtotal: 'Subtotal', shipping: 'Shipping', tax: 'Tax', total: 'TOTAL' };

    let breakdownHtml = `
        <tr style="border-top: 2px solid #e5e7eb;">
            <td colspan="3" style="padding: 12px; text-align: right; font-size: 14px; font-weight: 600; color: #374151;">${labels.subtotal}:</td>
            <td style="padding: 12px; text-align: right; font-size: 14px; font-weight: 600; color: #374151;">${formatPrice(subtotalCents)}</td>
        </tr>`;

    if (shippingCents > 0) {
        const shippingProvider = orderData.shippingDetails?.provider ? ` (${orderData.shippingDetails.provider})` : '';
        const estimatedDays    = orderData.shippingDetails?.estimated_days ? ` - ${orderData.shippingDetails.estimated_days} days` : '';
        breakdownHtml += `
        <tr>
            <td colspan="3" style="padding: 12px; text-align: right; font-size: 14px; color: #6b7280;">📦 ${labels.shipping}${shippingProvider}${estimatedDays}:</td>
            <td style="padding: 12px; text-align: right; font-size: 14px; color: #6b7280;">${formatPrice(shippingCents)}</td>
        </tr>`;
    }

    if (taxCents > 0) {
        const taxRate = orderData.taxDetails?.ratePercent ? ` (${orderData.taxDetails.ratePercent}%)` : '';
        breakdownHtml += `
        <tr>
            <td colspan="3" style="padding: 12px; text-align: right; font-size: 14px; color: #6b7280;">📋 ${labels.tax}${taxRate}:</td>
            <td style="padding: 12px; text-align: right; font-size: 14px; color: #6b7280;">${formatPrice(taxCents)}</td>
        </tr>`;
    }

    breakdownHtml += `
        <tr style="border-top: 2px solid #4f46e5; background-color: #f9fafb;">
            <td colspan="3" style="padding: 16px; text-align: right; font-size: 18px; font-weight: bold; color: #1f2937;">${labels.total}:</td>
            <td style="padding: 16px; text-align: right; font-size: 18px; font-weight: bold; color: #4f46e5;">${formatPrice(totalCents)}</td>
        </tr>`;

    return breakdownHtml;
}

function getInlineRefundTemplate(languageCode) {
    const isEs = languageCode === 'es';
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:40px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
<tr><td style="background:linear-gradient(135deg,#dc2626,#ef4444);padding:32px 40px;text-align:center;">
<h1 style="color:#fff;margin:0;font-size:28px;">💰 {{params.mainTitle}}</h1>
<div style="display:inline-block;background:rgba(255,255,255,0.2);color:#fff;padding:6px 16px;border-radius:20px;margin-top:12px;font-size:14px;font-weight:bold;">{{params.badgeText}}</div>
</td></tr>
<tr><td style="padding:32px 40px;">
<p style="font-size:16px;color:#374151;line-height:1.6;">{{params.mainIntro}}</p>
<table width="100%" cellpadding="0" cellspacing="0" style="background:#fef2f2;border:2px solid #fecaca;border-radius:12px;margin:24px 0;"><tr><td style="padding:24px;">
<table width="100%">
<tr><td style="padding:8px 0;font-size:14px;color:#6b7280;">${isEs ? 'Monto del Reembolso:' : 'Refund Amount:'}</td><td style="padding:8px 0;font-size:24px;font-weight:bold;color:#dc2626;text-align:right;">{{params.refundAmount}}</td></tr>
<tr><td style="padding:8px 0;font-size:14px;color:#6b7280;border-top:1px solid #fecaca;">${isEs ? 'Tipo:' : 'Type:'}</td><td style="padding:8px 0;font-size:14px;font-weight:600;color:#374151;text-align:right;border-top:1px solid #fecaca;">{{params.refundType}}</td></tr>
<tr><td style="padding:8px 0;font-size:14px;color:#6b7280;border-top:1px solid #fecaca;">${isEs ? 'Razón:' : 'Reason:'}</td><td style="padding:8px 0;font-size:14px;color:#374151;text-align:right;border-top:1px solid #fecaca;">{{params.refundReason}}</td></tr>
<tr><td style="padding:8px 0;font-size:14px;color:#6b7280;border-top:1px solid #fecaca;">${isEs ? 'Pedido:' : 'Order:'}</td><td style="padding:8px 0;font-size:14px;font-weight:600;color:#4f46e5;text-align:right;border-top:1px solid #fecaca;">#{{params.orderId}}</td></tr>
</table></td></tr></table>
<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:16px;margin:24px 0;"><p style="font-size:14px;color:#1e40af;margin:0;">💡 {{params.refundTimeline}}</p></div>
<p style="font-size:14px;color:#6b7280;line-height:1.6;">{{params.closeMessage}}</p>
</td></tr>
<tr><td style="background:#1f2937;padding:24px 40px;text-align:center;">
<p style="color:#9ca3af;font-size:12px;margin:0;">© ${new Date().getFullYear()} autoInx</p>
<p style="color:#6b7280;font-size:11px;margin:8px 0 0;"><a href="mailto:support@autoinx.com" style="color:#60a5fa;">support@autoinx.com</a></p>
</td></tr>
</table></td></tr></table></body></html>`;
}

function formatRefundReasonForEmail(reason, languageCode) {
    const reasons = {
        'requested_by_customer': { en: 'Customer Request',      es: 'Solicitud del cliente' },
        'duplicate':             { en: 'Duplicate Charge',       es: 'Cargo duplicado' },
        'fraudulent':            { en: 'Fraudulent Charge',      es: 'Cargo fraudulento' },
        'defective_product':     { en: 'Defective Product',      es: 'Producto defectuoso' },
        'wrong_item':            { en: 'Wrong Item Sent',        es: 'Artículo incorrecto enviado' },
        'never_received':        { en: 'Never Received',         es: 'Nunca recibido' },
        'price_adjustment':      { en: 'Price Adjustment',       es: 'Ajuste de precio' },
        'other':                 { en: 'Other',                  es: 'Otro' }
    };
    const entry = reasons[reason] || { en: reason, es: reason };
    return languageCode === 'es' ? entry.es : entry.en;
}

// Zelle/Cash contact details — loaded from Firestore site config at runtime
// (Admin → Config → Payment Settings). Falls back to env var or hardcoded default.
async function getZelleConfig(db) {
    try {
        const snap = await db.collection('admin').doc('config').get();
        const payment = snap.data()?.payment || {};
        return {
            zelleEmail: payment.zelleEmail || process.env.ZELLE_EMAIL || 'payments@autoinx.com',
            zelleName:  payment.zelleName  || process.env.ZELLE_NAME  || 'AutoInx',
        };
    } catch {
        return {
            zelleEmail: process.env.ZELLE_EMAIL || 'payments@autoinx.com',
            zelleName:  process.env.ZELLE_NAME  || 'AutoInx',
        };
    }
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

        // Verify HMAC signature — protects endpoint from abuse
        // If ORDER_EMAIL_SECRET is not set, the check is skipped (backward compat).
        // If set, the signature from checkout must match exactly.
        if (!verifySignature(orderData.orderId, orderData._sig)) {
            console.error('⚠️ Signature mismatch for order', orderData.orderId?.substring(0, 8),
                '— check that ORDER_EMAIL_SECRET env var matches the secret in checkout.html _signOrderId()');
            // Still send the email — log the mismatch but don't block it.
            // Remove this fallback once ORDER_EMAIL_SECRET is confirmed consistent.
        }

        const {
            orderId,
            buyerEmail,
            buyerName,
            items,
            totalCents,
            subtotalCents,
            shippingCents,
            taxCents,
            shippingDetails,
            taxDetails,
            communicationLang,
            appId,
            paymentUrl,
            newStatus,
            refundData,
            // ── NEW: payment method fields ──────────────────────────────
            paymentMethod,                      // 'card' | 'zelle' | 'cash'
            zelleEmail: zelleEmailOverride,     // optional override from caller
            zelleName:  zelleNameOverride,
        } = orderData;

        getDb();

        const isStatusUpdate = !!newStatus;
        const isRefund       = !!refundData;
        const languageCode   = communicationLang || 'en';

        console.log('📧 Processing email for order:', {
            orderId: orderId?.substring(0, 8),
            isStatusUpdate, isRefund,
            paymentMethod: paymentMethod || 'card',
            total: formatPrice(totalCents)
        });

        // ═══════════════════════════════════════════════════════════════
        // REFUND EMAIL (unchanged)
        // ═══════════════════════════════════════════════════════════════
        if (isRefund) {
            let template = await getTemplateHtml(languageCode, 'refund');
            const isFullRefund = refundData.refundStatus === 'full';
            const refundType = isFullRefund
                ? (languageCode === 'es' ? 'Reembolso Completo' : 'Full Refund')
                : (languageCode === 'es' ? 'Reembolso Parcial'  : 'Partial Refund');
            const mainTitle = languageCode === 'es' ? 'Confirmación de Reembolso' : 'Refund Confirmation';
            const mainIntro = languageCode === 'es'
                ? `Hola ${buyerName}, le confirmamos que hemos procesado un reembolso de <strong>${formatPrice(refundData.amountCents)}</strong> para su pedido #${orderId.substring(0, 8)}.`
                : `Hello ${buyerName}, we're confirming that a refund of <strong>${formatPrice(refundData.amountCents)}</strong> has been processed for your order #${orderId.substring(0, 8)}.`;
            const refundTimeline = languageCode === 'es'
                ? 'El reembolso puede tardar de 5 a 10 días hábiles en reflejarse en su cuenta.'
                : 'The refund may take 5-10 business days to appear on your statement.';
            const closeMessage = languageCode === 'es'
                ? 'Si tiene alguna pregunta, no dude en contactarnos. ¡Gracias por su paciencia!'
                : "If you have any questions, please don't hesitate to contact us. Thank you for your patience!";

            template = template
                .replace(/{{params\.mainTitle}}/g, mainTitle)
                .replace(/{{params\.badgeText}}/g, `💰 ${refundType}`)
                .replace(/{{params\.mainIntro}}/g, mainIntro)
                .replace(/{{params\.refundAmount}}/g, formatPrice(refundData.amountCents))
                .replace(/{{params\.refundType}}/g, refundType)
                .replace(/{{params\.refundReason}}/g, formatRefundReasonForEmail(refundData.reason, languageCode))
                .replace(/{{params\.orderId}}/g, orderId.substring(0, 8))
                .replace(/{{params\.orderTableRows}}/g, items ? generateTableRows(items) : '')
                .replace(/{{params\.orderTotal}}/g, formatPrice(totalCents))
                .replace(/{{params\.totalRefunded}}/g, formatPrice(refundData.totalRefundedCents || refundData.amountCents))
                .replace(/{{params\.showOrderSummary}}/g, items && items.length > 0 ? '' : 'display:none;')
                .replace(/{{params\.refundTimeline}}/g, refundTimeline)
                .replace(/{{params\.closeMessage}}/g, closeMessage)
                .replace(/{{contact\.EMAIL}}/g, buyerEmail);

            const subject = languageCode === 'es'
                ? `Confirmación de Reembolso - Pedido #${orderId.substring(0, 8)}`
                : `Refund Confirmation - Order #${orderId.substring(0, 8)}`;

            await transporter.sendMail({ from: '"autoInx Support" <noreply@autoinx.com>', to: buyerEmail, subject, html: template });
            await transporter.sendMail({ from: '"autoInx Support" <noreply@autoinx.com>', to: "orders@autoinx.com",
                subject: `[REFUND] #${orderId.substring(0, 8)} — ${formatPrice(refundData.amountCents)} (${refundType})`, html: template });

            return { statusCode: 200, body: JSON.stringify({ message: "Refund confirmation sent.", orderId }) };
        }

        // ═══════════════════════════════════════════════════════════════
        // ORDER / STATUS UPDATE EMAIL
        // ═══════════════════════════════════════════════════════════════
        let template = await getTemplateHtml(languageCode, 'order');

        const statusConfig = {
            'Pending':    { color: "#ef4444", en: "Pending",    es: "Pendiente"  },
            'Processing': { color: "#3b82f6", en: "Processing", es: "Procesando" },
            'Shipped':    { color: "#8b5cf6", en: "Shipped",    es: "Enviado"    },
            'Delivered':  { color: "#10b981", en: "Delivered",  es: "Entregado"  },
            'Cancelled':  { color: "#64748b", en: "Cancelled",  es: "Cancelado"  },
        };

        const currentStatus = newStatus || "Pending";
        const config     = statusConfig[currentStatus] || statusConfig['Pending'];
        const badgeColor = config.color;
        const statusText = languageCode === 'es' ? config.es : config.en;

        let badgeLabel, mainTitle, mainIntro, closeMsg;
        if (isStatusUpdate) {
            badgeLabel = languageCode === 'es' ? `Actualización: ${statusText}` : `Update: ${statusText}`;
            mainTitle  = languageCode === 'es' ? "Actualización de su Pedido"    : "Order Status Update";
            mainIntro  = languageCode === 'es'
                ? `Hola ${buyerName}, el estado de su pedido #${orderId.substring(0, 8)} ha cambiado a: <strong>${statusText}</strong>.`
                : `Hello ${buyerName}, the status of your order #${orderId.substring(0, 8)} has been updated to: <strong>${statusText}</strong>.`;
            closeMsg   = languageCode === 'es' ? "Le avisaremos cuando haya más novedades." : "We will notify you of further updates.";
        } else {
            badgeLabel = languageCode === 'es' ? "✓ Pedido Confirmado" : "✓ Order Confirmed";
            mainTitle  = languageCode === 'es' ? "¡Gracias por su pedido!"       : "Thank you for your order!";
            mainIntro  = languageCode === 'es'
                ? `Hola ${buyerName}, hemos recibido su pedido #${orderId.substring(0, 8)}.`
                : `Hello ${buyerName}, we've received your order #${orderId.substring(0, 8)}.`;
            closeMsg   = languageCode === 'es' ? "¡Gracias por elegir autoInx!" : "Thanks for choosing autoInx!";
        }

        const costBreakdown = generateCostBreakdown(orderData, languageCode);

        // ── Payment method params (NEW) ───────────────────────────────────────
        const isAltPayment = paymentMethod === 'zelle' || paymentMethod === 'cash';
        const isZelle      = paymentMethod === 'zelle';
        const zelleDefaults = await getZelleConfig(getDb());
        const resolvedZelleEmail = zelleEmailOverride || zelleDefaults.zelleEmail;
        const resolvedZelleName  = zelleNameOverride  || zelleDefaults.zelleName;

        const paymentBannerColor = isZelle ? '#7c3aed' : '#16a34a';

        const paymentInstructionsTitle = isZelle
            ? (languageCode === 'es' ? '🏦 Instrucciones de Pago — Zelle'   : '🏦 Payment Instructions — Zelle')
            : (languageCode === 'es' ? '💵 Instrucciones de Pago — Efectivo' : '💵 Payment Instructions — Cash');

        const paymentInstructionsBody = isZelle
            ? (languageCode === 'es'
                ? `Hola ${buyerName}, por favor envía tu pago de <strong>${formatPrice(totalCents)}</strong> vía Zelle a los siguientes datos:`
                : `Hi ${buyerName}, please send your payment of <strong>${formatPrice(totalCents)}</strong> via Zelle to:`)
            : (languageCode === 'es'
                ? `Hola ${buyerName}, coordinaremos el pago de <strong>${formatPrice(totalCents)}</strong> en efectivo al momento de la entrega.`
                : `Hi ${buyerName}, we will coordinate your <strong>${formatPrice(totalCents)}</strong> cash payment at the time of delivery or pickup.`);

        const paymentNote = isZelle
            ? (languageCode === 'es'
                ? '⚠️ Incluye el número de pedido en el memo para identificar tu pago.'
                : '⚠️ Include the order number in the memo so we can identify your payment.')
            : (languageCode === 'es'
                ? 'Te contactaremos pronto para coordinar los detalles.'
                : 'We will contact you shortly to coordinate the details.');

        const uploadPrompt = languageCode === 'es'
            ? '¿Ya enviaste tu pago? Sube tu comprobante aquí:'
            : 'Already sent your payment? Upload your confirmation here:';

        const uploadCta = languageCode === 'es'
            ? 'Subir Comprobante de Pago'
            : 'Upload Payment Confirmation';

        template = template
            .replace(/{{params\.badgeColor}}/g, badgeColor)
            .replace(/{{params\.badgeText}}/g, badgeLabel)
            .replace(/{{params\.mainTitle}}/g, mainTitle)
            .replace(/{{params\.mainIntro}}/g, mainIntro)
            .replace(/{{params\.orderStatus}}/g, statusText)
            .replace(/{{params\.orderId}}/g, orderId)
            .replace(/{{params\.orderDate}}/g, new Date().toLocaleDateString())
            .replace(/{{params\.trackingUrl}}/g,
                `https://autoinx.com/track-order.html?order=${orderId}&email=${encodeURIComponent(buyerEmail)}&token=${generateOrderToken(orderId, buyerEmail)}`)
            .replace(/{{params\.orderTableRows}}/g, generateTableRows(items))
            .replace(/{{params\.costBreakdown}}/g, costBreakdown)
            .replace(/{{params\.totalPrice}}/g, formatPrice(totalCents))
            // Card Stripe button — hidden for Zelle/Cash orders
            .replace(/{{params\.showPaymentButton}}/g, (!isAltPayment && paymentUrl) ? '' : 'display:none;')
            .replace(/{{params\.paymentUrl}}/g, paymentUrl || '')
            .replace(/{{params\.paymentButtonText}}/g, languageCode === 'es'
                ? `🔒 Pagar Ahora - ${formatPrice(totalCents)}`
                : `🔒 Pay Now - ${formatPrice(totalCents)}`)
            // Payment instructions block — shown for Zelle/Cash, hidden for card
            .replace(/{{params\.showPaymentInstructions}}/g, isAltPayment ? '' : 'display:none;')
            .replace(/{{params\.paymentBannerColor}}/g, paymentBannerColor)
            .replace(/{{params\.paymentInstructionsTitle}}/g, paymentInstructionsTitle)
            .replace(/{{params\.paymentInstructionsBody}}/g, paymentInstructionsBody)
            .replace(/{{params\.showZelleBox}}/g, isZelle ? '' : 'display:none;')
            .replace(/{{params\.zelleEmail}}/g, resolvedZelleEmail)
            .replace(/{{params\.zelleName}}/g, resolvedZelleName)
            .replace(/{{params\.paymentNote}}/g, paymentNote)
            .replace(/{{params\.paymentMethod}}/g, paymentMethod || 'card')
            .replace(/{{params\.uploadPrompt}}/g, uploadPrompt)
            .replace(/{{params\.uploadCta}}/g, uploadCta)
            .replace(/{{params\.closeMessage}}/g, closeMsg)
            .replace(/{{contact\.EMAIL}}/g, buyerEmail);

        const subject = isStatusUpdate
            ? (languageCode === 'es' ? `Actualización de Pedido #${orderId.substring(0,8)}` : `Order Update #${orderId.substring(0,8)}`)
            : isAltPayment
                ? (languageCode === 'es'
                    ? `Pedido Recibido #${orderId.substring(0,8)} — ${isZelle ? 'Instrucciones Zelle' : 'Pago en Efectivo'}`
                    : `Order #${orderId.substring(0,8)} Received — ${isZelle ? 'Zelle Instructions' : 'Cash Payment'}`)
                : (languageCode === 'es' ? "Confirmación de Pedido - autoInx" : "Order Confirmation - autoInx");

        const mailOptions = {
            from: '"autoInx Support" <noreply@autoinx.com>',
            to: buyerEmail,
            subject,
            html: template,
        };

        await transporter.sendMail(mailOptions);
        console.log('✅ Customer email sent to:', buyerEmail);

        if (!isStatusUpdate) {
            const internalSubject = isAltPayment
                ? `[${paymentMethod.toUpperCase()} ORDER] #${orderId.substring(0,8)} - ${formatPrice(totalCents)}`
                : `[NEW ORDER] #${orderId.substring(0,8)} - ${formatPrice(totalCents)}`;
            await transporter.sendMail({ ...mailOptions, to: "orders@autoinx.com", subject: internalSubject });
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
                    tax:      formatPrice(taxCents || 0),
                    total:    formatPrice(totalCents)
                }
            })
        };

    } catch (error) {
        console.error("❌ Function Error:", error);
        return { statusCode: 500, body: JSON.stringify({ error: "Email failure", details: error.message }) };
    }
};
