/**
 * Netlify Function: sendContactEmail.js
 * Receives contact form submissions and routes the email using Brevo SMTP,
 * adapting the order confirmation template for professional formatting.
 */
const nodemailer = require("nodemailer");
const fs = require("fs").promises;
const path = require("path");

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

// Load + adapt template
async function getContactTemplate(data) {
    let template = await getEmailHtml();

    // Header Change
    const headerReplacement =
        data.subjectType === "order"
            ? "New Order Inquiry Received"
            : "New General Support Message";

    template = template.replace(/Your autoInx Order is Confirmed/g, headerReplacement);

    // Intro paragraph
    const introText =
        data.subjectType === "order"
            ? "We have received a question regarding an order. Details below:"
            : "A new message has been submitted via the contact form. Details below:";

    // Contact table
    const contactDetailsTable = `
        <p style="margin-bottom: 20px; font-size: 16px;">
            ${introText}
        </p>
        <table width="100%" cellspacing="0" cellpadding="0" border="0" role="presentation"
            style="border-collapse: collapse; margin-top: 20px; table-layout: fixed; font-size: 16px;">
            <tr style="background-color: #f3f4f6;">
                <td colspan="2" style="padding: 12px; font-weight: bold; font-size: 18px; color: #6366f1;">
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
                <td style="padding: 12px; border-bottom: 1px solid #eee;">${
                    data.subjectType === "order" ? "ORDER QUESTION" : "GENERAL SUPPORT"
                }</td>
            </tr>
            <tr>
                <td colspan="2" style="padding: 15px 12px; font-weight: bold;">Message:</td>
            </tr>
            <tr>
                <td colspan="2" style="padding: 0 12px 15px 12px; background-color: #f9f9f9; color:#555;">
                    ${data.message.replace(/\n/g, "<br>")}
                </td>
            </tr>
        </table>
    `;

    // Replace order summary section if it exists
    const orderSectionPattern =
        /<p style="margin-bottom: 20px; font-size: 16px;">[\s\S]*?<table[\s\S]*?<\/table>/;

    if (orderSectionPattern.test(template)) {
        template = template.replace(orderSectionPattern, contactDetailsTable);
    } else {
        // fallback: just inject table at top
        template = contactDetailsTable + template;
    }

    // Cleanup placeholders
    template = template
        .replace(/{{params\.orderId}}/g, "")
        .replace(/{{params\.orderDate}}/g, "")
        .replace(/{{params\.orderTableRows}}/g, "")
        .replace(/{{params\.totalPrice}}/g, "");

    // Replace final generic confirmation line
    template = template.replace(
        /We will send you a separate email notification when your order is ready\./g,
        "Please allow up to 24 hours for a response to your inquiry."
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

        const subject =
            subjectType === "order"
                ? `[Order Inquiry] New Question from ${name}`
                : `[General Support] New Message from ${name}`;

        const htmlBody = await getContactTemplate({
            name,
            email,
            subjectType,
            message,
        });

        await transporter.sendMail({
            from: process.env.BREVO_SMTP_USER || "noreply@autoinx.com",
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
