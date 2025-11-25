/**
 * Netlify Function: sendContactEmail.js
 * Receives contact form submissions and routes the email using Brevo SMTP,
 * utilizing the order confirmation template for professional formatting.
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

// 2. Function to load and adapt the template for contact submissions
async function getContactTemplate(data) {
    const templatePath = path.resolve(process.env.LAMBDA_TASK_ROOT || process.cwd(), 'netlify/functions/emailTemplates/orderConfirmationTemplate.html');
    let template = await fs.readFile(templatePath, 'utf8');

    // --- Template Adaptation ---

    // 1. Update Header/Title (Assuming a general title placeholder is used)
    template = template.replace(/Your autoInx Order is Confirmed/g, 
        data.subjectType === 'order' ? 'New Order Inquiry Received' : 'New General Support Message');
    
    // 2. Update Introductory Text
    const introText = data.subjectType === 'order' 
        ? `We have received a question regarding an order. Details below:` 
        : `A new message has been submitted via the contact form. Details below:`;
        
    // 3. Construct the Contact Details Table HTML
    const contactDetailsTable = `
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
                <td colspan="2" style="padding: 0 12px 15px 12px; color: #555;">
                    ${data.message.replace(/\n/g, '<br>')}
                </td>
            </tr>
        </table>
    `;

    // 4. Inject Content into the Template
    // We must replace the Order ID, Date, and the entire Order Items Table block.
    
    // We target the entire section containing the IDs/Dates and the Item Table.
    const patternToReplace = /<p style="font-size: 16px;"><strong>Order ID:<\/strong>[\s\S]*?<table width="100%" cellspacing="0" cellpadding="0" border="0" role="presentation" style="border-collapse: collapse; margin-top: 20px; table-layout: fixed;">[\s\S]*?<\/table>/;
    
    // Replace Order IDs, Dates, and the entire Items Table with the new Contact Table
    template = template.replace(patternToReplace, contactDetailsTable);
    
    // Replace the default intro paragraph
    template = template.replace(/Hello, thank you for your purchase! We've received your order and are preparing your items for delivery./g, introText);


    // 5. Clean up any remaining Brevo/Nodemailer placeholders that are not standard Brevo tags
    template = template.replace(/{{params\.orderId}}/g, '');
    template = template.replace(/{{params\.orderDate}}/g, '');
    template = template.replace(/{{params\.orderTableRows}}/g, '');
    template = template.replace(/{{params\.totalPrice}}/g, '');
    
    return template;
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
        console.error('Email Processing Error:', error.message);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to process contact submission.', details: error.message })
        };
    }
};
