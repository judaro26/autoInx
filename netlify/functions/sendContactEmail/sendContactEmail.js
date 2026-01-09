/**
 * Netlify Function: sendContactEmail.js
 * Receives contact form submissions, includes rate limiting and honeypot for security, 
 * and routes the email using Brevo SMTP with dynamic templating.
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
 * NEW: Loads base HTML template dynamically based on language
 */
async function getEmailHtml(lang = 'en') {
    try {
        const filename = lang === 'es' 
            ? "contactSubmissionTemplateSpanish.html" 
            : "contactSubmissionTemplate.html";
            
        // Use path.resolve for better reliability in bundled environments
        const templatePath = path.resolve(__dirname, "emailTemplates", filename);
        return await fs.readFile(templatePath, "utf8");
    } catch (error) {
        console.error("Error reading contact email template:", error);
        throw new Error("Failed to load email template");
    }
}

/**
 * Loads the contact template and populates all dynamic placeholders.
 */
async function getContactTemplate(data, runtimeData) {
    // Detect if we should use Spanish based on subjectType (e.g. "PEDIDO")
    const isSpanish = data.subjectType.toUpperCase().includes("PEDIDO") || data.subjectType.toUpperCase().includes("ORDEN");
    let template = await getEmailHtml(isSpanish ? 'es' : 'en');

    // 1. --- Dynamic Header/Title Updates ---
    const headerReplacement = isSpanish
        ? "Consulta de Pedido Recibida"
        : "Mensaje de Soporte General";

    template = template.replace(/Nuevo Mensaje Recibido/g, headerReplacement);

    // 2. --- Global Placeholder Replacement ---
    template = template.replace(/{{name}}/g, data.name);
    template = template.replace(/{{email}}/g, data.email);
    template = template.replace(/{{subjectType}}/g, data.subjectType.toUpperCase());

    const formattedMessage = data.message.replace(/\n/g, "<br>");
    template = template.replace(/{{message}}/g, formattedMessage);

    template = template.replace(/{{recipientEmail}}/g, runtimeData.recipientEmail);
    template = template.replace(/{{timestamp}}/g, runtimeData.timestamp);
    template = template.replace(/{{ip}}/g, runtimeData.ip || 'N/A');
    
    // 3. --- Dynamic Button Link Update ---
    const mailToSubject = isSpanish
        ? `Re: Consulta de Pedido de ${data.name}` 
        : `Re: Support Inquiry from ${data.name}`;
        
    const mailToBody = isSpanish 
        ? `Hola ${data.name},%0A%0AGracias%20por%20contactarnos...`
        : `Hello ${data.name},%0A%0AThank%20you%20for%20contacting%20us...`;
    
    const dynamicMailTo = `mailto:${data.email}?subject=${encodeURIComponent(mailToSubject)}&body=${mailToBody}`;
    template = template.replace(/href="mailto:{{email}}[^"]*"/, `href="${dynamicMailTo}"`);
    
    // 4. --- Response Time SLA Message ---
    const dayOfWeek = new Date().getDay(); 
    let responseTimeMessage;

    if (dayOfWeek === 0 || dayOfWeek === 6) {
        responseTimeMessage = isSpanish 
            ? "Reconocemos tu consulta. Un agente se pondrá en contacto el **próximo día hábil**."
            : "We have received your inquiry. An agent will contact you during the **next business day**.";
    } else {
        responseTimeMessage = isSpanish
            ? "Reconocemos tu consulta. Un agente se pondrá en contacto en las **próximas 24 horas hábiles**."
            : "We have received your inquiry. An agent will contact you within **24 business hours**.";
    }

    template = template.replace(/{{responseTimeMessage}}/g, responseTimeMessage);

    // Cleanup unnecessary placeholders from shared template logic
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

    const clientIp = event.headers['client-ip'] || event.headers['x-nf-client-connection-ip'] || 'unknown';
    const now = Date.now();
    
    if (!rateLimitStore[clientIp]) { rateLimitStore[clientIp] = []; }
    rateLimitStore[clientIp] = rateLimitStore[clientIp].filter(timestamp => timestamp > now - RATE_LIMIT_WINDOW_MS);
    
    if (rateLimitStore[clientIp].length >= MAX_REQUESTS_PER_HOUR) {
        return {
            statusCode: 429,
            body: JSON.stringify({ error: `Rate limit exceeded. Try again later.` }),
        };
    }
    rateLimitStore[clientIp].push(now);

    try {
        const { name, email, subjectType, message, urlCheck } = JSON.parse(event.body);

        if (urlCheck) {
            return { statusCode: 200, body: JSON.stringify({ message: "Success (bot)" }) }; 
        }
        
        const sanitizedData = {
            name: sanitizeString(name),
            email: sanitizeString(email),
            subjectType: sanitizeString(subjectType),
            message: sanitizeString(message)
        };

        if (!sanitizedData.name || !sanitizedData.email || !sanitizedData.message) {
            return { statusCode: 400, body: JSON.stringify({ error: "Missing required fields." }) };
        }

        const adminRecipient = sanitizedData.subjectType.toLowerCase().includes("order") || sanitizedData.subjectType.toLowerCase().includes("pedido") 
            ? "orders@autoinx.com" 
            : "support@autoinx.com";
            
        const currentTime = new Date();
        const runtimeData = {
            recipientEmail: adminRecipient, 
            timestamp: currentTime.toLocaleString('es-CO'),
            ip: clientIp,
        };

        const htmlBody = await getContactTemplate(sanitizedData, runtimeData);

        const adminSubject = adminRecipient === "orders@autoinx.com"
            ? `[Order Inquiry] New Question from ${sanitizedData.name}`
            : `[General Support] New Message from ${sanitizedData.name}`;

        // Send to Admin
        await transporter.sendMail({
            from: "noreply@autoinx.com", 
            to: adminRecipient, 
            subject: adminSubject,
            html: htmlBody,
            replyTo: sanitizedData.email,
        });

        // Send to Customer
        await transporter.sendMail({
            from: "noreply@autoinx.com", 
            to: sanitizedData.email,
            subject: `Copia de tu Consulta - AutoInx`, 
            html: htmlBody,
            replyTo: adminRecipient, 
        });

        return {
            statusCode: 200,
            body: JSON.stringify({ message: "Emails sent successfully." }),
        };
    } catch (error) {
        console.error("Email Processing Error:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "Failed to process submission", details: error.message }),
        };
    }
};
