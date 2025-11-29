/**
 * Netlify Function: sendContactEmail.js
 * Receives contact form submissions, includes rate limiting and honeypot for security, 
 * and routes the email using Brevo SMTP with dynamic templating.
 */
const nodemailer = require("nodemailer");
const fs = require("fs").promises;
const path = require("path");

// --- CRITICAL FIX: Global Rate Limiting Variables ---
const rateLimitStore = {}; 
const MAX_REQUESTS_PER_HOUR = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

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

// Helper function to sanitize strings and prevent XSS
function sanitizeString(str) {
    if (!str) return '';
    // Simple filter to prevent XSS (Cross-Site Scripting) injection
    return String(str).replace(/</g, "&lt;").replace(/>/g, "&gt;").trim();
}

// Load base HTML template
async function getEmailHtml() {
    try {
        // This path is defined relative to the directory containing this function file
        const templatePath = path.join(__dirname, "emailTemplates", "contactSubmissionTemplate.html"); 
        return await fs.readFile(templatePath, "utf8");
    } catch (error) {
        console.error("Error reading contact email template:", error);
        throw new Error("Failed to load email template");
    }
}

/**
 * Loads the contact template and populates all dynamic placeholders.
 * @param {object} data - Sanitized submission data (name, email, subjectType, message)
 * @param {object} runtimeData - Server-side data (recipientEmail, timestamp, ip)
 */
async function getContactTemplate(data, runtimeData) {
    let template = await getEmailHtml();

    // 1. --- Dynamic Header/Title Updates ---
    const headerReplacement =
        data.subjectType.includes("ORDER")
            ? "Consulta de Pedido Recibida"
            : "Mensaje de Soporte General";

    // Replace main header title (e.g., in the <title> or main h1)
    template = template.replace(/Nuevo Mensaje Recibido/g, headerReplacement);

    // 2. --- Global Placeholder Replacement (Populate all {{variables}}) ---
    
    // Basic fields
    template = template.replace(/{{name}}/g, data.name);
    template = template.replace(/{{email}}/g, data.email);
    template = template.replace(/{{subjectType}}/g, data.subjectType.toUpperCase());

    // Message field (replace newlines with <br> for HTML)
    const formattedMessage = data.message.replace(/\n/g, "<br>");
    template = template.replace(/{{message}}/g, formattedMessage);

    // Server/Runtime Data fields
    template = template.replace(/{{recipientEmail}}/g, runtimeData.recipientEmail);
    template = template.replace(/{{timestamp}}/g, runtimeData.timestamp);
    template = template.replace(/{{ip}}/g, runtimeData.ip || 'N/A');
    
    // 3. --- Dynamic Button Link Update ---
    const mailToSubject = data.subjectType.includes("ORDER")
        ? `Re: Consulta de Pedido de ${data.name}` 
        : `Re: Consulta de Soporte de ${data.name}`;
        
    const mailToBody = `Hola ${data.name},%0A%0AGracias%20por%20contactarnos.%20En%20un%20momento%20te%20responderemos...`;
    
    const dynamicMailTo = `mailto:${data.email}?subject=${encodeURIComponent(mailToSubject)}&body=${mailToBody}`;
    
    // Find the original mailto link placeholder and replace it fully
    template = template.replace(/href="mailto:{{email}}[^"]*"/, `href="${dynamicMailTo}"`);
    
    
    // 4. --- Response Time SLA Message ---
    const dayOfWeek = new Date().getDay(); // 0 = Sunday, 6 = Saturday
    let responseTimeMessage;

    if (dayOfWeek === 0 || dayOfWeek === 6) {
        // It's Saturday or Sunday
        responseTimeMessage = "Reconocemos tu consulta. Un agente de soporte se pondrá en contacto contigo durante el **próximo día hábil**.";
    } else {
        // It's Monday through Friday
        responseTimeMessage = "Reconocemos tu consulta. Un agente de soporte se pondrá en contacto contigo en las **próximas 24 horas hábiles**.";
    }

    // Replace the new placeholder in the template
    template = template.replace(/{{responseTimeMessage}}/g, responseTimeMessage);

    // Cleanup unnecessary placeholders
    template = template
        .replace(/{{params\.orderId}}/g, "")
        .replace(/{{params\.orderDate}}/g, "")
        .replace(/{{params\.orderTableRows}}/g, "")
        .replace(/{{params\.totalPrice}}/g, "");

    return template;
}

// --- Netlify Handler ---
exports.handler = async function (event) {
    if (event.httpMethod !== "POST") {
        return {
            statusCode: 405,
            body: JSON.stringify({ error: "Method Not Allowed" }),
        };
    }

    // 1. Get client IP
    const clientIp = event.headers['client-ip'] || event.headers['x-nf-client-connection-ip'] || 'unknown';
    const now = Date.now();
    
    // 2. --- Rate Limit Check (Abuse Prevention) ---
    if (!rateLimitStore[clientIp]) {
        rateLimitStore[clientIp] = [];
    }
    
    // Remove requests older than the window
    rateLimitStore[clientIp] = rateLimitStore[clientIp].filter(timestamp => timestamp > now - RATE_LIMIT_WINDOW_MS);
    
    if (rateLimitStore[clientIp].length >= MAX_REQUESTS_PER_HOUR) {
        console.warn(`Rate limit exceeded for IP: ${clientIp}`);
        return {
            statusCode: 429, // Too Many Requests
            body: JSON.stringify({ error: `Rate limit exceeded. Please try again later. (Max ${MAX_REQUESTS_PER_HOUR} per hour)` }),
        };
    }
    
    // 3. Record the current request timestamp
    rateLimitStore[clientIp].push(now);

    try {
        const { name, email, subjectType, message, urlCheck } = JSON.parse(event.body);

        // --- SANITIZE USER INPUTS ---
        const sanitizedName = sanitizeString(name);
        const sanitizedEmail = sanitizeString(email);
        const sanitizedSubjectType = sanitizeString(subjectType);
        const sanitizedMessage = sanitizeString(message);
        // -----------------------------

        // 4. --- Honeypot Check (Bot Mitigation) ---
        if (urlCheck) {
            console.warn(`Honeypot triggered by IP: ${clientIp}`);
            // Return 200 OK to fool the bot, but skip sending the email
            return { statusCode: 200, body: JSON.stringify({ message: "Thank you for your submission (bot detected)" }) }; 
        }
        
        // 5. --- Input Validation ---
        if (!sanitizedName || !sanitizedEmail || !sanitizedSubjectType || !sanitizedMessage) {
            return { statusCode: 400, body: JSON.stringify({ error: "Missing required fields after sanitization." }) };
        }

        // 6. --- Prepare Email Data & Recipients ---
        const adminRecipient =
            sanitizedSubjectType.toLowerCase().includes("order") ? "orders@autoinx.com" : "support@autoinx.com";
            
        const customerRecipient = sanitizedEmail;
        
        const currentTime = new Date();
        const runtimeData = {
            recipientEmail: adminRecipient, 
            timestamp: currentTime.toLocaleDateString('es-CO') + ' ' + currentTime.toLocaleTimeString('es-CO'),
            ip: clientIp,
        };

        // Generate the HTML body using SANITIZED variables
        const htmlBody = await getContactTemplate({ 
            name: sanitizedName, 
            email: sanitizedEmail, 
            subjectType: sanitizedSubjectType, 
            message: sanitizedMessage 
        }, runtimeData);

        // 7. --- Send Emails ---
        
        const adminSubject = sanitizedSubjectType.toLowerCase().includes("order")
            ? `[Order Inquiry] New Question from ${sanitizedName}`
            : `[General Support] New Message from ${sanitizedName}`;

        const customerSubject = `Copia de tu Consulta - AutoInx`;
        
        // 7a. Send to Admin/Orders
        await transporter.sendMail({
            from: "noreply@autoinx.com", 
            to: adminRecipient, 
            subject: adminSubject,
            html: htmlBody,
            replyTo: sanitizedEmail,
        });

        // 7b. Send copy to Customer
        await transporter.sendMail({
            from: "noreply@autoinx.com", 
            to: customerRecipient,
            subject: customerSubject, 
            html: htmlBody,
            replyTo: adminRecipient, 
        });

        return {
            statusCode: 200,
            body: JSON.stringify({ message: "Email sent successfully to admin and submitter.", recipient: customerRecipient }),
        };
    } catch (error) {
        console.error("Email Processing Error:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "Failed to process contact submission", details: error.message }),
        };
    }
};
