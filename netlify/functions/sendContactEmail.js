/**
 * Netlify Function: sendContactEmail.js
 * Receives contact form submissions and routes the email using Brevo SMTP,
 * using a template for professional formatting.
 */
const nodemailer = require('nodemailer');
const fs = require('fs').promises; // Node.js utility to read files
const path = require('path');

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

// 2. Function to load and substitute template variables
async function getContactTemplate(data) {
    const templatePath = path.resolve(process.env.LAMBDA_TASK_ROOT || process.cwd(), 'netlify/functions/emailTemplates/orderConfirmationTemplate.html');
    let template = await fs.readFile(templatePath, 'utf8');

    // --- Template Adaptation: Replace Order-Specific Placeholders with Contact Data ---
    
    // Replace standard template headers/titles (assuming they exist)
    template = template.replace(/{{email_title}}/g, data.subjectType === 'order' ? 'Nueva Pregunta de Pedido' : 'Nueva Consulta General');
    template = template.replace(/{{customer_name}}/g, data.name);
    template = template.replace(/{{order_summary_header}}/g, 'Detalles de la Consulta');
    
    // Replace the main table/body content with the contact message
    const messageTableContent = `
        <tr>
            <td style="padding: 20px 0; border-bottom: 1px solid #eee;">
                <p style="font-size: 18px; color: #333; margin: 0 0 10px 0;"><strong>Remitente:</strong> ${data.name} (${data.email})</p>
                <p style="font-size: 18px; color: #333; margin: 0 0 10px 0;"><strong>Tipo de Consulta:</strong> ${data.subjectType === 'order' ? 'Relacionada con Pedido' : 'General / Soporte'}</p>
                <p style="font-size: 18px; color: #333; margin: 0 0 10px 0;"><strong>Mensaje:</strong></p>
                <p style="font-size: 16px; color: #555; margin: 0;">${data.message.replace(/\n/g, '<br>')}</p>
            </td>
        </tr>
        <tr>
            <td style="padding: 15px 0 0 0;">
                <p style="font-size: 14px; color: #888;">Este email fue generado por el formulario de contacto de AutoInx.</p>
            </td>
        </tr>
    `;

    // You will need to identify the main content table placeholder in your HTML template (e.g., {{order_details_table}})
    // For this example, I'll assume your template has a placeholder like {{main_content_details}}
    // Please adjust this based on your actual template structure.
    return template.replace(/{{main_content_details}}/g, messageTableContent);
}

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    try {
        const { name, email, subjectType, message } = JSON.parse(event.body);

        if (!name || !email || !subjectType || !message) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields' }) };
        }

        // --- Routing Logic ---
        const recipient = subjectType === 'order' ? 'orders@autoinx.com' : 'support@autoinx.com';
        const subject = subjectType === 'order' 
            ? `[Order Inquiry] New Question from ${name}` 
            : `[General Support] New Message from ${name}`;

        // 3. Generate HTML Content from the adapted template
        const htmlBody = await getContactTemplate({ name, email, subjectType, message });

        const mailOptions = {
            from: process.env.BREVO_SMTP_USER || 'noreply@autoinx.com', 
            to: recipient,
            subject: subject,
            html: htmlBody,
            replyTo: email
        };

        // --- Sending Email via Nodemailer/Brevo ---
        await transporter.sendMail(mailOptions);

        console.log(`Contact email successfully routed to ${recipient}.`);

        return {
            statusCode: 200,
            body: JSON.stringify({ message: 'Email sent successfully', recipient: recipient })
        };

    } catch (error) {
        // Log error and include details about file reading failure if applicable
        console.error('Email Processing Error:', error.message);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to process contact submission.', details: error.message })
        };
    }
};
