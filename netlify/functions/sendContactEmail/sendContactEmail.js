/**
 * Netlify Function: sendContactEmail.js
 * Receives contact form submissions with rate limiting, honeypot,
 * and sends templated emails via Brevo SMTP.
 * Enhanced with order number & preferred language support.
 */
const nodemailer = require("nodemailer");
const fs = require("fs").promises;
const path = require("path");

// --- Configuration and Rate Limiting ---
const rateLimitStore = {};
const MAX_REQUESTS_PER_HOUR = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

const transporter = nodemailer.createTransport({
    host: process.env.BREVO_SMTP_HOST,
    port: process.env.BREVO_SMTP_PORT,
    secure: false,
    auth: {
        user: process.env.BREVO_SMTP_USER,
        pass: process.env.BREVO_SMTP_PASSWORD,
    },
});

function sanitizeString(str) {
    if (!str) return '';
    return String(str).replace(/</g, "&lt;").replace(/>/g, "&gt;").trim();
}

/**
 * Loads the appropriate HTML email template based on language
 */
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

/**
 * Loads template and replaces all dynamic placeholders
 */
async function getContactTemplate(data, runtimeData) {
    // Language priority:
    // 1. Explicit user preference
    // 2. Keywords in subject type (PEDIDO/ORDEN)
    // 3. Default: Spanish
    const isSpanish = 
        data.preferredLang === 'es' ||
        data.preferredLang === 'es-CO' ||
        (data.subjectType || '').toUpperCase().includes("PEDIDO") ||
        (data.subjectType || '').toUpperCase().includes("ORDEN");

    const lang = isSpanish ? 'es' : 'en';
    let template = await getEmailHtml(lang);

    // 1. Dynamic Header/Title
    const headerReplacement = isSpanish
        ? "Consulta de Pedido Recibida"
        : "Support Message Received";

    template = template.replace(/Nuevo Mensaje Recibido/g, headerReplacement);

    // 2. Global replacements
    template = template.replace(/{{name}}/g, data.name || '—');
    template = template.replace(/{{email}}/g, data.email || '—');
    template = template.replace(/{{subjectType}}/g, (data.subjectType || '—').toUpperCase());

    const formattedMessage = (data.message || '').replace(/\n/g, "<br>");
    template = template.replace(/{{message}}/g, formattedMessage);

    // 3. Order number (NEW)
    const orderSection = data.orderNumber
        ? (isSpanish
            ? `<p><strong>Número de Pedido:</strong> ${sanitizeString(data.orderNumber)}</p>`
            : `<p><strong>Order Number:</strong> ${sanitizeString(data.orderNumber)}</p>`)
        : '';

    template = template.replace(/{{orderNumber}}/g, orderSection);

    template = template.replace(/{{recipientEmail}}/g, runtimeData.recipientEmail);
    template = template.replace(/{{timestamp}}/g, runtimeData.timestamp);
    template = template.replace(/{{ip}}/g, runtimeData.ip || 'N/A');

    // 4. Dynamic Reply Button
    const mailToSubject = isSpanish
        ? `Re: Consulta de ${data.name}${data.orderNumber ? ` - Pedido ${data.orderNumber}` : ''}`
        : `Re: Inquiry from ${data.name}${data.orderNumber ? ` - Order ${data.orderNumber}` : ''}`;

    const mailToBody = isSpanish
        ? `Hola ${data.name},%0A%0AGracias por contactarnos...`
        : `Hello ${data.name},%0A%0AThank you for contacting us...`;

    const dynamicMailTo = `mailto:${data.email}?subject=${encodeURIComponent(mailToSubject)}&body=${mailToBody}`;
    template = template.replace(/href="mailto:{{email}}[^"]*"/, `href="${dynamicMailTo}"`);

    // 5. Response Time Message
    const dayOfWeek = new Date().getDay();
    let responseTimeMessage;
    if (dayOfWeek === 0 || dayOfWeek === 6) {
        responseTimeMessage = isSpanish
            ? "Reconocemos tu consulta. Un agente se pondrá en contacto el **próximo día hábil**."
            : "We received your inquiry. An agent will contact you on the **next business day**.";
    } else {
        responseTimeMessage = isSpanish
            ? "Reconocemos tu consulta. Un agente se pondrá en contacto en las **próximas 24 horas hábiles**."
            : "We received your inquiry. An agent will contact you within **24 business hours**.";
    }
    template = template.replace(/{{responseTimeMessage}}/g, responseTimeMessage);

    // Cleanup unused placeholders (order-related ones from other templates)
    template = template
        .replace(/{{params\.orderId}}/g, "")
        .replace(/{{params\.orderDate}}/g, "")
        .replace(/{{params\.orderTableRows}}/g, "")
        .replace(/{{params\.totalPrice}}/g, "");

    return template;
}

exports.handler = async function (event) {
    if (event.httpMethod !== "POST") {
        return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
    }

    const clientIp = event.headers['client-ip'] ||
                    event.headers['x-nf-client-connection-ip'] ||
                    event.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
                    'unknown';

    const now = Date.now();

    if (!rateLimitStore[clientIp]) rateLimitStore[clientIp] = [];
    rateLimitStore[clientIp] = rateLimitStore[clientIp].filter(ts => ts > now - RATE_LIMIT_WINDOW_MS);

    if (rateLimitStore[clientIp].length >= MAX_REQUESTS_PER_HOUR) {
        return {
            statusCode: 429,
            body: JSON.stringify({ error: "Rate limit exceeded. Please try again later." })
        };
    }

    rateLimitStore[clientIp].push(now);

    try {
        const body = JSON.parse(event.body);
        const {
            name,
            email,
            subjectType,
            message,
            urlCheck,
            orderNumber,        // optional
            preferredLang = 'es' // optional - default Spanish
        } = body;

        // Honeypot trap
        if (urlCheck) {
            return { statusCode: 200, body: JSON.stringify({ message: "Success (bot detected)" }) };
        }

        const sanitizedData = {
            name: sanitizeString(name),
            email: sanitizeString(email),
            subjectType: sanitizeString(subjectType),
            message: sanitizeString(message),
            orderNumber: sanitizeString(orderNumber),
            preferredLang: sanitizeString(preferredLang).toLowerCase()
        };

        if (!sanitizedData.name || !sanitizedData.email || !sanitizedData.subjectType || !sanitizedData.message) {
            return { statusCode: 400, body: JSON.stringify({ error: "Missing required fields" }) };
        }

        // Decide recipient
        const isOrderRelated = 
            sanitizedData.subjectType.toLowerCase().includes("order") ||
            sanitizedData.subjectType.toLowerCase().includes("pedido") ||
            sanitizedData.orderNumber;

        const adminRecipient = isOrderRelated ? "orders@autoinx.com" : "support@autoinx.com";

        const currentTime = new Date();
        const runtimeData = {
            recipientEmail: adminRecipient,
            timestamp: currentTime.toLocaleString('es-CO', { timeZone: 'America/Bogota' }),
            ip: clientIp
        };

        const htmlBody = await getContactTemplate(sanitizedData, runtimeData);

        const adminSubject = isOrderRelated
            ? `[Order Inquiry] New Question from ${sanitizedData.name}${sanitizedData.orderNumber ? ` (#${sanitizedData.orderNumber})` : ''}`
            : `[General Support] New Message from ${sanitizedData.name}`;

        // 1. Send to Admin/Orders team
        await transporter.sendMail({
            from: "noreply@autoinx.com",
            to: adminRecipient,
            subject: adminSubject,
            html: htmlBody,
            replyTo: sanitizedData.email,
        });

        // 2. Send copy to customer
        await transporter.sendMail({
            from: "noreply@autoinx.com",
            to: sanitizedData.email,
            subject: isSpanish ? "Copia de tu Consulta - AutoInx" : "Copy of Your Inquiry - AutoInx",
            html: htmlBody,
            replyTo: adminRecipient,
        });

        return {
            statusCode: 200,
            body: JSON.stringify({ message: "Emails sent successfully" })
        };

    } catch (error) {
        console.error("Email Processing Error:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: "Failed to process submission",
                details: error.message
            })
        };
    }
};
