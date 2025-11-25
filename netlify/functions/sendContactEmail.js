/**
 * Netlify Function: sendContactEmail.js
 * Receives contact form submissions and routes the email using Brevo SMTP,
 * adapting the order confirmation template for professional formatting.
 */
const nodemailer = require('nodemailer');
const fs = require('fs').promises; // Node.js utility to read files
const path = require('path');

// 1. Configure Nodemailer Transporter using Brevo SMTP details
const transporter = nodemailer.createTransport({
    // Using environment variables for security and deployment flexibility
    host: process.env.BREVO_SMTP_HOST,
    port: process.env.BREVO_SMTP_PORT,
    secure: false, // Brevo typically uses port 587 without explicit SSL/TLS on some plans
    auth: {
        user: process.env.BREVO_SMTP_USER,
        pass: process.env.BREVO_SMTP_PASSWORD,
    },
});

// 2. Function to load and adapt the template for contact submissions
async function getContactTemplate(data) {
    // CRITICAL FIX: Use __dirname for reliable path resolution in Netlify Lambda
    const templatePath = path.join(__dirname, 'emailTemplates', 'orderConfirmationTemplate.html');
    let template = await fs.readFile(templatePath, 'utf8');

    // --- Template Adaptation ---

    // 1. Update Header/Title
    template = template.replace(/Your autoInx Order is Confirmed/g, 
        data.subjectType === 'order' ? 'New Order Inquiry Received' : 'New General Support Message');
    
    // 2. Update Introductory Text
    const introText = data.subjectType === 'order' 
        ? `We have received a question regarding an order. Details below:` 
        : `A new message has been submitted via the contact form. Details below:`;
        
    // 3. Construct the Contact Details Table HTML
    const contactDetailsTable = `
        <p style="margin-bottom: 20px; font-size: 16px;">
            ${introText}
        </p>
        <table width="100%" cellspacing="0" cellpadding="0" border="0" role="presentation" style="border-collapse: collapse; margin-top: 20px; table-layout: fixed; font-size: 16px;">
            <tr style="background-color: #f3f4f6;">
                <td colspan="2" style="padding: 12px; text-align: left; font-weight: bold; font-size: 18px; color: #6366f1;">
                    Submission Details
                </td>
            </tr>
            <tr>
                <td style="padding: 12px; border-bottom: 1px solid #eee; font-weight: bold; width: 30%;">Name:</td>
                <td style="padding: 12px; border-bottom: 1px solid #eee;">${data.name}</td>
            </tr>
            <tr>
                <td style="padding: 12px; border-bottom: 1px solid #eee; font-weight: bold;">Email:</td>
                <td style="padding: 12px; border-bottom: 1px solid #eee;">${data.email}</td>
            </tr>
            <tr>
                <td style="padding: 12px; border-bottom: 1px solid #eee; font-weight: bold;">Query Type:</td>
                <td style="padding: 12px; border-bottom: 1px solid #eee;">${data.subjectType === 'order' ? 'ORDER QUESTION' : 'GENERAL SUPPORT'}</td>
            </tr>
            <tr>
                <td colspan="2" style="padding: 15px 12px; font-weight: bold; border-top: 1px solid #ddd;">Message:</td>
            </tr>
            <tr>
                <td colspan="2" style="padding: 0 12px 15px 12px; color: #555; background-color: #f9f9f9; border-radius: 4px;">
                    ${data.message.replace(/\n/g, '<br>')}
                </td>
            </tr>
        </table>
    `;

    // 4. Inject Contact Table (Requires a specific placeholder in the original template)
    // For simplicity, let's assume the template content you provided is stored in the variable 'template'.
    
    // We target the entire Order Summary section from the "Hello, thank you..." paragraph 
    // up to and including the closing </p> tag before the footer starts.
    
    // NOTE: This regex targets the intro paragraph, the two <p> tags with Order ID/Date, 
    // and the entire items table. This is robust for the template you showed.
    const orderSectionPattern = /<p style="margin-bottom: 20px; font-size: 16px;">[\s\S]*?<p style="margin-bottom: 30px;"><strong>Order Date:<\/strong>[\s\S]*?<table width="100%" cellspacing="0" cellpadding="0" border="0" role="presentation" style="border-collapse: collapse; margin-top: 20px; table-layout: fixed;">[\s\S]*?<\/table>/;

    template = template.replace(orderSectionPattern, contactDetailsTable);

    // 5. Clean up remaining dynamic placeholders if any were missed outside the pattern
    template = template.replace(/{{params\.orderId}}/g, '');
    template = template.replace(/{{params\.orderDate}}/g, '');
    template = template.replace(/{{params\.orderTableRows}}/g, '');
    template = template.replace(/{{params\.totalPrice}}/g, '');
    
    // 6. Replace the generic confirmation message at the end
    template = template.replace(/We will send you a separate email notification when your order is ready./g, 
        'Please allow up to 24 hours for a response to your inquiry.');

    return template;
}

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    // Nodemailer and file reading dependencies (fs, path) are needed here

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
        // Log the exact error for debugging Netlify/FS issues
        if (error.code === 'ENOENT') {
            console.error(`File not found error: Check path: netlify/functions/emailTemplates/orderConfirmationTemplate.html`);
        }
        console.error('Email Processing Error:', error.message);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to process contact submission.', details: error.message })
        };
    }
};
