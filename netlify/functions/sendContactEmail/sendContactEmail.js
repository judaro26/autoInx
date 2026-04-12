/**
 * Netlify Function: sendContactEmail.js
 *
 * Saves every contact form submission to Firestore first, then sends emails.
 * This ensures submissions are never lost even if the email provider is down.
 */
const nodemailer = require("nodemailer");
const fs         = require("fs").promises;
const path       = require("path");
const admin      = require("firebase-admin");

// ── Firebase Admin ────────────────────────────────────────────────────────────
function initAdmin() {
    if (admin.apps.length === 0) {
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId:   process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            }),
        });
    }
    return admin.firestore();
}

// ── Rate limiting (in-memory, per Lambda instance) ───────────────────────────
const rateLimitStore        = {};
const MAX_REQUESTS_PER_HOUR = 5;
const RATE_LIMIT_WINDOW_MS  = 60 * 60 * 1000;

// ── Helpers ───────────────────────────────────────────────────────────────────
function sanitizeString(str) {
    if (!str) return '';
    return String(str).replace(/</g, "&lt;").replace(/>/g, "&gt;").trim();
}

async function getEmailHtml(lang = 'es') {
    try {
        const filename = lang === 'es'
            ? "contactSubmissionTemplateSpanish.html"
            : "contactSubmissionTemplate.html";
        const templatePath = path.resolve(__dirname, "emailTemplates", filename);
        return await fs.readFile(templatePath, "utf8");
    } catch (error) {
        console.error("Error reading email template:", error);
        throw new Error("Failed to load email template");
    }
}

async function getContactTemplate(data, runtimeData, isSpanish) {
    const lang = isSpanish ? 'es' : 'en';
    let template = await getEmailHtml(lang);

    const headerReplacement = isSpanish
        ? "Consulta de Pedido Recibida"
        : "Support Message Received";
    template = template.replace(/Nuevo Mensaje Recibido/g, headerReplacement);

    template = template.replace(/{{name}}/g, data.name || '—');
    template = template.replace(/{{email}}/g, data.email || '—');
    template = template.replace(/{{subjectType}}/g, (data.subjectType || '—').toUpperCase());

    const formattedMessage = (data.message || '').replace(/\n/g, "<br>");
    template = template.replace(/{{message}}/g, formattedMessage);

    const orderSection = data.orderNumber
        ? (isSpanish
            ? `<div class="info-card"><div class="label">Número de Pedido</div><div class="value"><strong>#${data.orderNumber}</strong></div></div>`
            : `<div class="info-card"><div class="label">Order Number</div><div class="value"><strong>#${data.orderNumber}</strong></div></div>`)
        : '';
    template = template.replace(/{{orderNumber}}/g, orderSection);
    template = template.replace(/{{recipientEmail}}/g, runtimeData.recipientEmail);
    template = template.replace(/{{timestamp}}/g, runtimeData.timestamp);
    template = template.replace(/{{ip}}/g, runtimeData.ip || 'N/A');

    const mailToSubject = isSpanish
        ? `Re: Consulta de ${data.name}${data.orderNumber ? ` - Pedido ${data.orderNumber}` : ''}`
        : `Re: Inquiry from ${data.name}${data.orderNumber ? ` - Order ${data.orderNumber}` : ''}`;
    const mailToBody = isSpanish
        ? `Hola ${data.name},%0A%0AGracias por contactarnos...`
        : `Hello ${data.name},%0A%0AThank you for contacting us...`;
    const dynamicMailTo = `mailto:${data.email}?subject=${encodeURIComponent(mailToSubject)}&body=${mailToBody}`;
    template = template.replace(/href="mailto:{{email}}[^"]*"/, `href="${dynamicMailTo}"`);

    const dayOfWeek = new Date().getDay();
    const responseTimeMessage = (dayOfWeek === 0 || dayOfWeek === 6)
        ? (isSpanish
            ? "Reconocemos tu consulta. Un agente se pondrá en contacto el **próximo día hábil**."
            : "We received your inquiry. An agent will contact you on the **next business day**.")
        : (isSpanish
            ? "Reconocemos tu consulta. Un agente se pondrá en contacto en las **próximas 24 horas hábiles**."
            : "We received your inquiry. An agent will contact you within **24 business hours**.");
    template = template.replace(/{{responseTimeMessage}}/g, responseTimeMessage);

    template = template
        .replace(/{{params\.orderId}}/g, "")
        .replace(/{{params\.orderDate}}/g, "")
        .replace(/{{params\.orderTableRows}}/g, "")
        .replace(/{{params\.totalPrice}}/g, "");

    return template;
}

// ── Handler ───────────────────────────────────────────────────────────────────
exports.handler = async function (event) {
    if (event.httpMethod !== "POST") {
        return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
    }

    // ── Rate limiting ─────────────────────────────────────────────────────────
    const clientIp = event.headers['client-ip'] ||
                     event.headers['x-nf-client-connection-ip'] ||
                     event.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
                     'unknown';

    const now = Date.now();
    if (!rateLimitStore[clientIp]) rateLimitStore[clientIp] = [];
    rateLimitStore[clientIp] = rateLimitStore[clientIp].filter(ts => ts > now - RATE_LIMIT_WINDOW_MS);
    if (rateLimitStore[clientIp].length >= MAX_REQUESTS_PER_HOUR) {
        return { statusCode: 429, body: JSON.stringify({ error: "Rate limit exceeded. Please try again later." }) };
    }
    rateLimitStore[clientIp].push(now);

    // ── Parse & validate ──────────────────────────────────────────────────────
    let body;
    try {
        body = JSON.parse(event.body);
    } catch {
        return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
    }

    const { name, email, subjectType, message, urlCheck, orderNumber, preferredLang = 'es' } = body;

    // Honeypot
    if (urlCheck) {
        return { statusCode: 200, body: JSON.stringify({ message: "Success (bot detected)" }) };
    }

    const sanitizedData = {
        name:         sanitizeString(name),
        email:        sanitizeString(email),
        subjectType:  sanitizeString(subjectType),
        message:      sanitizeString(message),
        orderNumber:  sanitizeString(orderNumber),
        preferredLang: sanitizeString(preferredLang).toLowerCase(),
    };

    if (!sanitizedData.name || !sanitizedData.email || !sanitizedData.subjectType || !sanitizedData.message) {
        return { statusCode: 400, body: JSON.stringify({ error: "Missing required fields" }) };
    }

    const isSpanish = sanitizedData.preferredLang.startsWith('es') ||
                      sanitizedData.subjectType.toUpperCase().includes("PEDIDO") ||
                      sanitizedData.subjectType.toUpperCase().includes("ORDEN");

    const isOrderRelated = sanitizedData.subjectType.toLowerCase().includes("order") ||
                           sanitizedData.subjectType.toLowerCase().includes("pedido") ||
                           (sanitizedData.orderNumber?.length > 0);

    const adminRecipient = isOrderRelated ? "orders@autoinx.com" : "support@autoinx.com";

    // ── 1. Save submission to Firestore FIRST ─────────────────────────────────
    // Submissions are always persisted regardless of email success/failure.
    const db = initAdmin();
    const submissionRef = db.collection('contact_submissions').doc();

    await submissionRef.set({
        name:          sanitizedData.name,
        email:         sanitizedData.email,
        subjectType:   sanitizedData.subjectType,
        message:       sanitizedData.message,
        orderNumber:   sanitizedData.orderNumber || null,
        preferredLang: sanitizedData.preferredLang,
        isOrderRelated,
        adminRecipient,
        ip:            clientIp,
        submittedAt:   admin.firestore.FieldValue.serverTimestamp(),
        emailSent:     false,
        emailError:    null,
        read:          false,
    });

    // ── 2. Validate SMTP config before attempting to send ─────────────────────
    const smtpHost = process.env.BREVO_SMTP_HOST;
    const smtpPort = process.env.BREVO_SMTP_PORT;
    const smtpUser = process.env.BREVO_SMTP_USER;
    const smtpPass = process.env.BREVO_SMTP_PASSWORD;

    if (!smtpHost || !smtpUser || !smtpPass) {
        const errMsg = "SMTP not configured — submission saved but email not sent. Add BREVO_SMTP_HOST, BREVO_SMTP_USER, and BREVO_SMTP_PASSWORD to your Netlify environment variables.";
        console.error(errMsg);
        await submissionRef.update({ emailError: "SMTP not configured" });
        // Still return 200 — the submission was saved; the user's message was received.
        return { statusCode: 200, body: JSON.stringify({ message: "Submission received. Email notifications are not configured yet." }) };
    }

    // ── 3. Send emails ────────────────────────────────────────────────────────
    try {
        // Create transporter inside the handler so it always uses current env vars
        const transporter = nodemailer.createTransport({
            host:   smtpHost,
            port:   parseInt(smtpPort, 10) || 587,
            secure: parseInt(smtpPort, 10) === 465,
            auth:   { user: smtpUser, pass: smtpPass },
        });

        const currentTime = new Date();
        const runtimeData = {
            recipientEmail: adminRecipient,
            timestamp:      currentTime.toLocaleString('es-CO', { timeZone: 'America/Bogota' }),
            ip:             clientIp,
        };

        const htmlBody = await getContactTemplate(sanitizedData, runtimeData, isSpanish);

        const adminSubject = isOrderRelated
            ? `[Order Inquiry] New Question from ${sanitizedData.name}${sanitizedData.orderNumber ? ` (#${sanitizedData.orderNumber})` : ''}`
            : `[General Support] New Message from ${sanitizedData.name}`;

        // Send to admin
        await transporter.sendMail({
            from:    "noreply@autoinx.com",
            to:      adminRecipient,
            subject: adminSubject,
            html:    htmlBody,
            replyTo: sanitizedData.email,
        });

        // Send confirmation copy to customer
        await transporter.sendMail({
            from:    "noreply@autoinx.com",
            to:      sanitizedData.email,
            subject: isSpanish ? "Copia de tu Consulta - AutoInx" : "Copy of Your Inquiry - AutoInx",
            html:    htmlBody,
            replyTo: adminRecipient,
        });

        // Mark as sent in Firestore
        await submissionRef.update({ emailSent: true, emailSentAt: admin.firestore.FieldValue.serverTimestamp() });

        return { statusCode: 200, body: JSON.stringify({ message: "Emails sent successfully" }) };

    } catch (emailError) {
        console.error("Email send error:", emailError);
        // Record the failure in Firestore — submission is still saved
        await submissionRef.update({ emailError: emailError.message });
        return {
            statusCode: 500,
            body: JSON.stringify({
                error:   "Your message was received but the confirmation email failed to send.",
                details: emailError.message,
            }),
        };
    }
};
