/**
 * Netlify Function: sendContactEmail.js
 * Receives contact form submissions and routes the email using Brevo SMTP,
 * adapting the base HTML template for professional formatting.
 */
const nodemailer = require("nodemailer");
const fs = require("fs").promises;
const path = require("path");

// --- Configuration ---
const transporter = nodemailer.createTransport({
    host: process.env.BREVO_SMTP_HOST,
    port: process.env.BREVO_SMTP_PORT,
    secure: false,
    auth: {
        user: process.env.BREVO_SMTP_USER,
        pass: process.env.BREVO_SMTP_PASSWORD,
    },
});

// Load base HTML template
async function getEmailHtml() {
    try {
        const templatePath = path.join(__dirname, "emailTemplates", "contactSubmissionTemplate.html");
        return await fs.readFile(templatePath, "utf8");
    } catch (error) {
        console.error("Error reading contact email template:", error);
        throw new Error("Failed to load email template");
    }
}

/**
 * Loads the contact template and populates all dynamic placeholders.
 * @param {object} data - Submission data (name, email, subjectType, message)
 * @param {object} runtimeData - Server-side data (recipientEmail, timestamp, ip)
 */
async function getContactTemplate(data, runtimeData) {
    let template = await getEmailHtml();

    // 1. --- Dynamic Header/Title Updates ---
    const headerReplacement =
        data.subjectType === "order"
            ? "Consulta de Pedido Recibida" // Order Inquiry Received
            : "Mensaje de Soporte General"; // General Support Message

    // Replace main header title (e.g., in the <title> or main h1)
    template = template.replace(/Nuevo Mensaje Recibido/g, headerReplacement);
    
    // Update the main page title in the hero section (H1)
    template = template.replace(/<h1>Nuevo Mensaje Recibido<\/h1>/, `<h1>${headerReplacement}</h1>`);


    // 2. --- Content Section Injection (If applicable, though unnecessary with full template) ---
    // NOTE: Since the template below uses placeholders ({{name}}, etc.), 
    // the previous manual table injection block is no longer needed. 
    // We only need to replace the placeholders directly.
    
    
    // 3. --- Global Placeholder Replacement (CRITICAL FIX) ---
    
    // Basic fields
    template = template.replace(/{{name}}/g, data.name);
    template = template.replace(/{{email}}/g, data.email);
    template = template.replace(/{{subjectType}}/g, data.subjectType.toUpperCase()); // Keep uppercase for highlight

    // Message field (replace newlines with <br> for HTML)
    const formattedMessage = data.message.replace(/\n/g, "<br>");
    template = template.replace(/{{message}}/g, formattedMessage);

    // Server/Runtime Data fields
    template = template.replace(/{{recipientEmail}}/g, runtimeData.recipientEmail);
    template = template.replace(/{{timestamp}}/g, runtimeData.timestamp);
    template = template.replace(/{{ip}}/g, runtimeData.ip || 'N/A');
    
    // 4. --- Dynamic Button Link Update (CRITICAL FIX) ---
    
    // Update the mailto link's subject line and body with dynamic data
    const mailToSubject = `Re: ${data.subjectType.toUpperCase()} - AutoInx`;
    const mailToBody = `Hola ${data.name},%0A%0AGracias%20por%20contactarnos.%20En%20un%20momento%20te%20responderemos...`;
    
    const dynamicMailTo = `mailto:${data.email}?subject=${encodeURIComponent(mailToSubject)}&body=${mailToBody}`;
    
    // Find the mailto link placeholder and replace it fully
    template = template.replace(/href="mailto:{{email}}[^"]*"/, `href="${dynamicMailTo}"`);
    
    
    // 5. --- Cleanup Order Placeholders (Existing good practice) ---
    template = template
        .replace(/{{params\.orderId}}/g, "")
        .replace(/{{params\.orderDate}}/g, "")
        .replace(/{{params\.orderTableRows}}/g, "")
        .replace(/{{params\.totalPrice}}/g, "");

    // Replace final generic confirmation line (If it exists in the template)
    template = template.replace(
        /We will send you a separate email notification when your order is ready\./g,
        "Please permite hasta 24 horas para recibir una respuesta a tu consulta."
    );

    return template;
}

// Netlify Handler
exports.handler = async function (event) {
    if (event.httpMethod !== "POST") {
        return {
            statusCode: 405,
            body: JSON.stringify({ error: "Method Not Allowed" }),
        };
    }

    try {
        const { name, email, subjectType, message } = JSON.parse(event.body);

        if (!name || !email || !subjectType || !message) {
            return { statusCode: 400, body: JSON.stringify({ error: "Missing required fields" }) };
        }

        const recipient =
            subjectType === "order" ? "orders@autoinx.com" : "support@autoinx.com";
            
        const currentTime = new Date();
        const runtimeData = {
            recipientEmail: recipient,
            timestamp: currentTime.toLocaleDateString('es-CO') + ' ' + currentTime.toLocaleTimeString('es-CO'),
            ip: event.headers['client-ip'] || event.headers['x-nf-client-connection-ip'] || 'Desconocida',
        };

        const subject =
            subjectType === "order"
                ? `[Order Inquiry] New Question from ${name}`
                : `[General Support] New Message from ${name}`;

        const htmlBody = await getContactTemplate({ name, email, subjectType, message }, runtimeData);

        await transporter.sendMail({
            // Using a hardcoded, verified sender is safer than BREVO_SMTP_USER
            from: "noreply@autoinx.com", 
            to: recipient,
            subject,
            html: htmlBody,
            replyTo: email,
        });

        return {
            statusCode: 200,
            body: JSON.stringify({ message: "Email sent successfully", recipient }),
        };
    } catch (error) {
        console.error("Email Processing Error:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "Failed to process contact submission", details: error.message }),
        };
    }
};
