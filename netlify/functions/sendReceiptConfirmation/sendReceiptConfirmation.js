const nodemailer = require("nodemailer");
const fs = require("fs").promises;
const path = require("path");
const fetch = require("node-fetch");

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
                <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: left; font-size: 14px; color: #334155;">${item.name}</td>
                <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: center; font-size: 14px; color: #334155;">${item.quantity}</td>
                <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: right; font-size: 14px; color: #334155;">${formatPrice(item.price)}</td>
                <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: right; font-size: 14px; font-weight: 600; color: #1e293b;">${formatPrice(subtotal)}</td>
            </tr>
        `;
    }).join('');
}

exports.handler = async function (event) {
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type" } };
    }

    if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

    try {
        const data = JSON.parse(event.body);
        const { orderId, buyerEmail, buyerName, items, paidCents, paymentMethod, language } = data;
        const lang = language === 'es' ? 'es' : 'en';

        // 1. Calculations & Timestamps
        const orderTotalCents = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
        const balanceCents = orderTotalCents - paidCents;
        const balanceColor = balanceCents <= 0 ? "#16a34a" : "#e11d48";
        
        const transactionTimestamp = new Date().toLocaleString(lang === 'es' ? 'es-ES' : 'en-US', {
            dateStyle: 'medium',
            timeStyle: 'short',
            timeZone: 'America/Bogota'
        });

        // 2. Load Template
        const templateName = lang === 'es' ? "paymentReceiptSpanish.html" : "paymentReceipt.html";
        const templatePath = path.join(__dirname, "emailTemplates", templateName);
        let htmlContent = await fs.readFile(templatePath, "utf8");

        // 3. Translations
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
            "{{params.transactionTimestamp}}": transactionTimestamp,
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

        // 4. GENERATE PDF VIA DOPPIO (Fixed Binary handling)
        const doppioRes = await fetch('https://api.doppio.sh/v1/render/pdf/direct', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.DOPPIO_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                page: {
                    setContent: { html: htmlContent },
                    pdf: {
                        format: 'A4',
                        printBackground: true,
                        margin: { top: '1cm', bottom: '1cm', left: '1cm', right: '1cm' }
                    }
                }
            })
        });

        if (!doppioRes.ok) throw new Error(`Doppio API Failed: ${await doppioRes.text()}`);

        const pdfArrayBuffer = await doppioRes.arrayBuffer();
        const pdfBuffer = Buffer.from(pdfArrayBuffer);

        // 5. Send Email
        await transporter.sendMail({
            from: '"autoInx Payments" <noreply@autoinx.com>',
            to: buyerEmail,
            subject: t.subject,
            html: htmlContent,
            attachments: [
                {
                    filename: t.filename,
                    content: pdfBuffer,
                    contentType: 'application/pdf',
                    encoding: 'base64'
                }
            ]
        });

        return { statusCode: 200, body: JSON.stringify({ message: "Success" }) };

    } catch (error) {
        console.error("Critical Receipt Error:", error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
