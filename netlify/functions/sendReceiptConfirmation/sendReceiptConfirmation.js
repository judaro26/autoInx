const nodemailer = require("nodemailer");
const fs = require("fs").promises;
const path = require("path");
const fetch = require("node-fetch");

const transporter = nodemailer.createTransport({
    host: process.env.BREVO_SMTP_HOST,
    port: parseInt(process.env.BREVO_SMTP_PORT || "587"),
    secure: false,
    auth: {
        user: process.env.BREVO_SMTP_USER,
        pass: process.env.BREVO_SMTP_PASSWORD,
    },
});

function formatPrice(cents) {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2
    }).format(cents / 100);
}

function generateTableRows(items) {
    return items.map(item => {
        const subtotal = item.price * item.quantity;
        return `
            <tr>
                <td style="padding: 16px 20px; border-bottom: 1px solid #e2e8f0; text-align: left; font-size: 15px; color: #334155;">${item.name}</td>
                <td style="padding: 16px 20px; border-bottom: 1px solid #e2e8f0; text-align: center; font-size: 15px; color: #334155;">${item.quantity}</td>
                <td style="padding: 16px 20px; border-bottom: 1px solid #e2e8f0; text-align: right; font-size: 15px; color: #334155;">${formatPrice(item.price)}</td>
                <td style="padding: 16px 20px; border-bottom: 1px solid #e2e8f0; text-align: right; font-size: 15px; font-weight: 700; color: #1e293b;">${formatPrice(subtotal)}</td>
            </tr>
        `;
    }).join('');
}

exports.handler = async function (event) {
    // Handle CORS preflight
    if (event.httpMethod === "OPTIONS") {
        return {
            statusCode: 200,
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "POST",
                "Access-Control-Allow-Headers": "Content-Type"
            }
        };
    }

    if (event.httpMethod !== "POST") {
        return { statusCode: 405, body: "Method Not Allowed" };
    }

    try {
        const data = JSON.parse(event.body);
        const {
            orderId,
            buyerEmail,
            buyerName,
            items,
            paidCents,
            paymentMethod,
            language,
            transactionId
        } = data;

        const lang = language === 'es' ? 'es' : 'en';

        // 1. Calculate totals and timestamp
        const orderTotalCents = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
        const balanceCents = orderTotalCents - paidCents;
        const balanceColor = balanceCents <= 0 ? "#16a34a" : "#e11d48";
        const finalTxnId = transactionId || `TXN-${Math.random().toString(36).toUpperCase().substring(2, 10)}`;

        const transactionTimestamp = new Date().toLocaleString(lang === 'es' ? 'es-ES' : 'en-US', {
            dateStyle: 'medium',
            timeStyle: 'short',
            timeZone: 'America/Bogota'
        });

        // 2. Load correct template
        const templateName = lang === 'es' ? "paymentReceiptSpanish.html" : "paymentReceipt.html";
        const templatePath = path.join(__dirname, "emailTemplates", templateName);
        let htmlContent = await fs.readFile(templatePath, "utf8");

        // 3. Language-specific strings
        const strings = {
            en: {
                subject: `Payment Receipt - Order #${orderId}`,
                financeSubject: `[INTERNAL] Payment Received - Order #${orderId}`,
                badge: "Payment Received",
                title: "Payment Confirmation",
                intro: `Hi ${buyerName}, your payment for order #${orderId} has been successfully processed.`,
                close: "Thank you for your business!",
                filename: `Receipt_${orderId}.pdf`
            },
            es: {
                subject: `Recibo de Pago - Pedido #${orderId}`,
                financeSubject: `[INTERNO] Pago Recibido - Pedido #${orderId}`,
                badge: "Pago Recibido",
                title: "Confirmación de Pago",
                intro: `Hola ${buyerName}, se ha procesado exitosamente su pago para el pedido #${orderId}.`,
                close: "¡Gracias por su compra!",
                filename: `Recibo_${orderId}.pdf`
            }
        };

        const t = strings[lang];

        // 4. Template replacements
        const replacements = {
            "{{params.badgeColor}}": "#10b981",
            "{{params.badgeText}}": t.badge,
            "{{params.mainTitle}}": t.title,
            "{{params.mainIntro}}": t.intro,
            "{{params.orderId}}": orderId,
            "{{params.transactionTimestamp}}": transactionTimestamp,
            "{{params.transactionId}}": finalTxnId,
            "{{params.paymentMethod}}": paymentMethod || "Other",
            "{{params.orderTotal}}": formatPrice(orderTotalCents),
            "{{params.totalPaid}}": formatPrice(paidCents),
            "{{params.remainingBalance}}": balanceCents <= 0 ? (lang === 'es' ? "Pagado totalmente" : "Paid in Full") : formatPrice(balanceCents),
            "{{params.balanceColor}}": balanceColor,
            "{{params.orderTableRows}}": generateTableRows(items),
            "{{params.closeMessage}}": t.close,
            "{{contact.EMAIL}}": buyerEmail
        };

        for (const [key, value] of Object.entries(replacements)) {
            htmlContent = htmlContent.split(key).join(value);
        }

        // 5. Generate PDF via Doppio (fixed version)
        const htmlBase64 = Buffer.from(htmlContent, 'utf8').toString('base64');

        const doppioRes = await fetch('https://api.doppio.sh/v1/render/pdf/direct', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.DOPPIO_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                page: {
                    setContent: { html: htmlBase64 },
                    pdf: {
                        format: 'A4',
                        printBackground: true,
                        margin: { top: '1cm', bottom: '1cm', left: '1cm', right: '1cm' }
                    }
                }
            })
        });

        if (!doppioRes.ok) {
            const errText = await doppioRes.text();
            throw new Error(`Doppio API Failed: ${doppioRes.status} - ${errText}`);
        }

        const pdfArrayBuffer = await doppioRes.arrayBuffer();
        const pdfBuffer = Buffer.from(pdfArrayBuffer);

        // 6. Send email to buyer AND CC finance
        await transporter.sendMail({
            from: '"autoInx Payments" <noreply@autoinx.com>',
            to: buyerEmail,                    // Buyer receives as main recipient
            cc: "finance@autoinx.com",         // Finance gets a copy
            subject: t.subject,                // Customer-friendly subject
            html: htmlContent,
            attachments: [
                {
                    filename: t.filename,
                    content: pdfBuffer,
                    contentType: 'application/pdf'
                }
            ]
        });

        // Optional: Send a separate internal-only email if you want a different subject
        // (uncomment if desired)
        /*
        await transporter.sendMail({
            from: '"autoInx System" <noreply@autoinx.com>',
            to: "finance@autoinx.com",
            subject: t.financeSubject,
            html: `<p>New payment recorded:</p>${htmlContent}`,
            attachments: [{ filename: t.filename, content: pdfBuffer, contentType: 'application/pdf' }]
        });
        */

        return {
            statusCode: 200,
            body: JSON.stringify({ message: "Receipt sent successfully to buyer and finance team" })
        };

    } catch (error) {
        console.error("Critical Receipt Error:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message || "Internal server error" })
        };
    }
};
