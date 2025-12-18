const nodemailer = require("nodemailer");
const fs = require("fs").promises;
const path = require("path");

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

// Generate the items table rows for the receipt
function generateTableRows(items) {
    return items.map(item => {
        const subtotal = item.price * item.quantity;
        return `
            <tr>
                <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: left; font-size: 14px;">${item.name}</td>
                <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: center; font-size: 14px;">${item.quantity}</td>
                <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: right; font-size: 14px;">${formatPrice(item.price)}</td>
                <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: right; font-size: 14px;">${formatPrice(subtotal)}</td>
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
        const { orderId, buyerEmail, buyerName, items, totalCents, paidCents, paymentMethod, language } = data;
        const lang = language === 'es' ? 'es' : 'en';

        // 1. Load the Template
        const templateName = lang === 'es' ? "paymentReceiptSpanish.html" : "paymentReceipt.html";
        const templatePath = path.join(__dirname, "emailTemplates", templateName);
        let html = await fs.readFile(templatePath, "utf8");

        // 2. Define Translations
        const strings = {
            en: {
                subject: `Payment Receipt for Order #${orderId.substring(0, 5)}`,
                badge: "Payment Received",
                title: "Payment Confirmation",
                intro: `Hi ${buyerName}, we have successfully processed your payment for order #${orderId.substring(0, 5)}.`,
                close: "Thank you for your business! Your order status will be updated shortly."
            },
            es: {
                subject: `Recibo de Pago - Pedido #${orderId.substring(0, 5)}`,
                badge: "Pago Recibido",
                title: "Confirmación de Pago",
                intro: `Hola ${buyerName}, hemos procesado exitosamente su pago para el pedido #${orderId.substring(0, 5)}.`,
                close: "¡Gracias por su compra! El estado de su pedido se actualizará pronto."
            }
        };

        const t = strings[lang];

        // 3. Perform Replacements
        const replacements = {
            "{{params.badgeColor}}": "#10b981",
            "{{params.badgeText}}": t.badge,
            "{{params.mainTitle}}": t.title,
            "{{params.mainIntro}}": t.intro,
            "{{params.orderId}}": orderId,
            "{{params.paymentDate}}": new Date().toLocaleDateString(lang === 'es' ? 'es-ES' : 'en-US'),
            "{{params.transactionId}}": `TXN-${Math.random().toString(36).toUpperCase().substring(2, 10)}`,
            "{{params.paymentMethod}}": paymentMethod || "Credit Card",
            "{{params.amountPaid}}": formatPrice(paidCents),
            "{{params.orderTableRows}}": generateTableRows(items),
            "{{params.totalPaid}}": formatPrice(paidCents),
            "{{params.closeMessage}}": t.close,
            "{{contact.EMAIL}}": buyerEmail
        };

        for (const [key, value] of Object.entries(replacements)) {
            html = html.split(key).join(value);
        }

        // 4. Send Email
        await transporter.sendMail({
            from: '"autoInx Payments" <noreply@autoinx.com>',
            to: buyerEmail,
            subject: t.subject,
            html: html,
        });

        return {
            statusCode: 200,
            body: JSON.stringify({ message: "Receipt sent successfully" }),
        };

    } catch (error) {
        console.error("Receipt error:", error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
