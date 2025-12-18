const nodemailer = require("nodemailer");
const fs = require("fs").promises;
const path = require("path");
const html_to_pdf = require('html-pdf-node'); // NEW Dependency

const transporter = nodemailer.createTransport({
    host: process.env.BREVO_SMTP_HOST,
    port: process.env.BREVO_SMTP_PORT,
    secure: false,
    auth: {
        user: process.env.BREVO_SMTP_USER,
        pass: process.env.BREVO_SMTP_PASSWORD,
    },
});

function formatPrice(cents) {
    return new Intl.NumberFormat('en-US', {
        style: 'currency', currency: 'USD', minimumFractionDigits: 2
    }).format(cents / 100);
}

function generateTableRows(items) {
    return items.map(item => {
        const subtotal = item.price * item.quantity;
        return `
            <tr>
                <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: left;">${item.name}</td>
                <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: center;">${item.quantity}</td>
                <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: right;">${formatPrice(item.price)}</td>
                <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: right; font-weight: bold;">${formatPrice(subtotal)}</td>
            </tr>
        `;
    }).join('');
}

exports.handler = async function (event) {
    if (event.httpMethod !== "POST") {
        return { statusCode: 405, body: "Method Not Allowed" };
    }

    try {
        const data = JSON.parse(event.body);
        const { orderId, buyerEmail, buyerName, items, paidCents, paymentMethod, language } = data;
        const lang = language === 'es' ? 'es' : 'en';

        // 1. Calculations
        const orderTotalCents = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
        const balanceCents = orderTotalCents - paidCents;
        const balanceColor = balanceCents <= 0 ? "#16a34a" : "#e11d48";

        // 2. Load Template
        const templateName = lang === 'es' ? "paymentReceiptSpanish.html" : "paymentReceipt.html";
        const templatePath = path.join(__dirname, "emailTemplates", templateName);
        let htmlContent = await fs.readFile(templatePath, "utf8");

        // 3. Translations & Replacements
        const strings = {
            en: {
                subject: `Payment Receipt for Order #${orderId.substring(0, 5)}`,
                badge: "Payment Received",
                title: "Payment Confirmation",
                intro: `Hi ${buyerName}, your payment for order #${orderId.substring(0, 5)} has been processed.`,
                close: "Thank you for your business!",
                balanceLabel: balanceCents <= 0 ? "PAID IN FULL" : "REMAINING BALANCE",
                filename: `Receipt_${orderId.substring(0, 5)}.pdf`
            },
            es: {
                subject: `Recibo de Pago - Pedido #${orderId.substring(0, 5)}`,
                badge: "Pago Recibido",
                title: "Confirmación de Pago",
                intro: `Hola ${buyerName}, se ha procesado su pago para el pedido #${orderId.substring(0, 5)}.`,
                close: "¡Gracias por su compra!",
                balanceLabel: balanceCents <= 0 ? "PAGADO TOTALMENTE" : "SALDO PENDIENTE",
                filename: `Recibo_${orderId.substring(0, 5)}.pdf`
            }
        };

        const t = strings[lang];

        const replacements = {
            "{{params.badgeColor}}": "#10b981",
            "{{params.badgeText}}": t.badge,
            "{{params.mainTitle}}": t.title,
            "{{params.mainIntro}}": t.intro,
            "{{params.orderId}}": orderId,
            "{{params.paymentDate}}": new Date().toLocaleDateString(lang === 'es' ? 'es-ES' : 'en-US'),
            "{{params.transactionId}}": `TXN-${Math.random().toString(36).toUpperCase().substring(2, 10)}`,
            "{{params.paymentMethod}}": paymentMethod || "Other",
            "{{params.orderTotal}}": formatPrice(orderTotalCents),
            "{{params.amountPaid}}": formatPrice(paidCents),
            "{{params.remainingBalance}}": balanceCents <= 0 ? t.balanceLabel : formatPrice(balanceCents),
            "{{params.balanceColor}}": balanceColor,
            "{{params.orderTableRows}}": generateTableRows(items),
            "{{params.totalPaid}}": formatPrice(paidCents),
            "{{params.closeMessage}}": t.close,
            "{{contact.EMAIL}}": buyerEmail
        };

        for (const [key, value] of Object.entries(replacements)) {
            htmlContent = htmlContent.split(key).join(value);
        }

        // 4. GENERATE PDF (NEW)
        const options = { format: 'A4', margin: { top: '20px', bottom: '20px' } };
        const file = { content: htmlContent };
        
        // This generates the PDF in memory as a Buffer
        const pdfBuffer = await html_to_pdf.generatePdf(file, options);

        // 5. Send Email with Attachment
        await transporter.sendMail({
            from: '"autoInx Payments" <noreply@autoinx.com>',
            to: buyerEmail,
            subject: t.subject,
            html: htmlContent, // The email body still looks nice
            attachments: [
                {
                    filename: t.filename,
                    content: pdfBuffer,
                    contentType: 'application/pdf'
                }
            ]
        });

        return {
            statusCode: 200,
            body: JSON.stringify({ message: "Receipt and PDF sent successfully" }),
        };

    } catch (error) {
        console.error("PDF/Email Error:", error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
