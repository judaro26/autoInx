const nodemailer = require('nodemailer');
const admin      = require('firebase-admin');

// ── Firebase init — runs once at module load ───────────────────────────────────
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId:   process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        }),
    });
}

const db = admin.firestore();

// ── Auth helper ────────────────────────────────────────────────────────────────
async function verifyIdToken(authHeader) {
    if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing auth token');
    const token = authHeader.slice(7);
    return admin.auth().verifyIdToken(token);
}

// ── Email transporter (Brevo SMTP) ────────────────────────────────────────────
function createTransport() {
    return nodemailer.createTransport({
        host:   process.env.BREVO_SMTP_HOST,
        port:   parseInt(process.env.BREVO_SMTP_PORT || '587'),
        secure: false,
        auth: {
            user: process.env.BREVO_SMTP_USER,
            pass: process.env.BREVO_SMTP_PASSWORD,
        },
    });
}

// ── Email HTML builder ─────────────────────────────────────────────────────────
function buildEmailHtml({ toName, message, introText, ctaText, couponCode, couponLabel,
                          localNote, storeName, logoUrl, siteUrl, categories,
                          headerColor1 = '#4f46e5', headerColor2 = '#7c3aed' }) {
    const greeting    = toName && toName !== 'there' ? `Hi ${toName},` : 'Hi there,';
    const personalMsg = message
        ? `<p style="font-size:16px;color:#374151;margin:0 0 12px;">${message}</p>` : '';

    const defaultIntro = `We're excited to share our latest product catalog with you. Browse our selection of quality auto parts and accessories below — and don't hesitate to reach out if you have any questions or need help finding the right part for your vehicle.`;
    const intro = introText || defaultIntro;
    const cta   = ctaText  || 'Shop the Full Catalog →';

    const localSection = localNote ? `
    <tr>
        <td style="padding:0 32px 24px;">
            <table width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#f0fdf4,#dcfce7);border-radius:12px;border:1px solid #bbf7d0;">
                <tr><td style="padding:20px 24px;">
                    <p style="margin:0 0 8px;font-size:18px;">🚚</p>
                    <p style="margin:0 0 6px;font-size:15px;font-weight:700;color:#15803d;">Shopping locally in the East Bay?</p>
                    <p style="margin:0;font-size:14px;color:#166534;line-height:1.6;">
                        Great news — if you're located in the <strong>East Bay Area</strong>, we may be able to deliver
                        directly to you at <strong>no delivery charge</strong>, and you likely won't need to pay
                        sales tax either. Just reach out and we'll confirm your area is covered.
                    </p>
                </td></tr>
            </table>
        </td>
    </tr>` : '';

    const couponSection = couponCode ? `
    <tr>
        <td style="padding:0 32px 24px;">
            <table width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#eff6ff,#dbeafe);border-radius:12px;border:1px solid #bfdbfe;">
                <tr><td style="padding:20px 24px;text-align:center;">
                    <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#1d4ed8;text-transform:uppercase;letter-spacing:2px;">Your Exclusive Coupon</p>
                    <p style="margin:0 0 4px;font-size:28px;font-weight:900;font-family:monospace;color:#1e40af;letter-spacing:3px;background:#fff;display:inline-block;padding:8px 24px;border-radius:8px;border:2px dashed #93c5fd;">${couponCode}</p>
                    <p style="margin:8px 0 0;font-size:14px;color:#1d4ed8;font-weight:600;">${couponLabel || 'Special discount just for you'}</p>
                    <p style="margin:4px 0 0;font-size:12px;color:#60a5fa;">Use at checkout · Limited time offer</p>
                </td></tr>
            </table>
        </td>
    </tr>` : '';

    const categoryBlocks = categories.map(cat => {
        const itemRows = cat.items.map(item => `
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:12px;background:#fff;border-radius:10px;border:1px solid #e5e7eb;overflow:hidden;">
                <tr>
                    ${item.imageUrl ? `
                    <td width="80" style="padding:12px 0 12px 12px;vertical-align:top;">
                        <img src="${item.imageUrl}" width="68" height="68"
                             style="object-fit:contain;border-radius:8px;background:#f9fafb;display:block;"
                             onerror="this.style.display='none'">
                    </td>` : ''}
                    <td style="padding:12px 14px;vertical-align:top;">
                        <p style="margin:0 0 2px;font-size:14px;font-weight:700;color:#1e1b4b;">${item.name}</p>
                        ${item.sku ? `<p style="margin:0 0 4px;font-size:11px;color:#9ca3af;font-family:monospace;">SKU: ${item.sku}</p>` : ''}
                        ${item.description ? `<p style="margin:0 0 6px;font-size:12px;color:#6b7280;line-height:1.5;">${item.description}</p>` : ''}
                        <p style="margin:0;font-size:16px;font-weight:900;color:${headerColor1};">$${item.price}</p>
                    </td>
                </tr>
            </table>`).join('');

        return `
            <tr>
                <td style="padding:0 32px 8px;">
                    <p style="margin:0 0 12px;font-size:11px;font-weight:800;color:${headerColor1};text-transform:uppercase;letter-spacing:3px;border-bottom:2px solid #e0e7ff;padding-bottom:6px;">${cat.name}</p>
                    ${itemRows}
                </td>
            </tr>`;
    }).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${storeName} — Product Catalog</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif;">

<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 16px;">
<tr><td align="center">

<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

    <tr>
        <td style="background:linear-gradient(135deg,${headerColor1},${headerColor2});padding:32px;text-align:center;">
            ${logoUrl ? `<img src="${logoUrl}" height="48" style="display:block;margin:0 auto 12px;object-fit:contain;" onerror="this.style.display='none'">` : ''}
            <h1 style="margin:0 0 4px;font-size:28px;font-weight:900;color:#ffffff;letter-spacing:-0.5px;">${storeName}</h1>
            <p style="margin:0;font-size:14px;color:rgba(255,255,255,0.8);letter-spacing:1px;text-transform:uppercase;">Product Catalog</p>
        </td>
    </tr>

    <tr>
        <td style="padding:32px 32px 20px;">
            <h2 style="margin:0 0 12px;font-size:22px;font-weight:800;color:#1e1b4b;">${greeting}</h2>
            ${personalMsg}
            <p style="margin:0;font-size:15px;color:#4b5563;line-height:1.7;">${intro}</p>
        </td>
    </tr>

    ${localSection}
    ${couponSection}

    <tr><td style="padding:0 32px 20px;">
        <hr style="border:none;border-top:2px solid #f3f4f6;margin:0;">
        <p style="margin:16px 0 0;font-size:20px;font-weight:800;color:#1e1b4b;">🛒 Our Products</p>
    </td></tr>

    ${categoryBlocks}

    <tr>
        <td style="padding:16px 32px 32px;text-align:center;">
            <a href="${siteUrl}" style="display:inline-block;background:linear-gradient(135deg,${headerColor1},${headerColor2});color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;padding:14px 36px;border-radius:50px;box-shadow:0 4px 12px rgba(79,70,229,0.35);">
                ${cta}
            </a>
        </td>
    </tr>

    <tr>
        <td style="background:#f8fafc;padding:24px 32px;border-top:1px solid #e5e7eb;text-align:center;">
            <p style="margin:0 0 6px;font-size:13px;color:#6b7280;">
                Questions? Email us at
                <a href="mailto:support@autoinx.com" style="color:${headerColor1};text-decoration:none;font-weight:600;">support@autoinx.com</a>
                or call <a href="tel:+13412227912" style="color:${headerColor1};text-decoration:none;font-weight:600;">341-222-7912</a>
            </p>
            <p style="margin:0;font-size:12px;color:#9ca3af;">
                <a href="${siteUrl}" style="color:#9ca3af;">${siteUrl}</a> · AutoInx Automotive Parts
            </p>
        </td>
    </tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

// ── Handler ────────────────────────────────────────────────────────────────────
exports.handler = async function(event) {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    try {
        await verifyIdToken(event.headers['authorization']);

        const {
            toEmail, toName = 'there', message = '', introText = '', ctaText = '',
            subject, couponCode, couponLabel,
            localNote = true, storeName = 'AutoInx',
            logoUrl, siteUrl = 'https://autoinx.com',
            categories = [], adminEmail,
            headerColor1 = '#4f46e5', headerColor2 = '#7c3aed',
            pdfBase64 = null,
        } = JSON.parse(event.body);

        if (!toEmail)                throw new Error('toEmail is required');
        if (categories.length === 0) throw new Error('No products to include');

        console.log(`📧 Sending catalog to ${toEmail} (${categories.length} categories, pdf=${!!pdfBase64})`);

        const emailHtml = buildEmailHtml({
            toName, message, introText, ctaText,
            couponCode, couponLabel, localNote,
            storeName, logoUrl, siteUrl, categories,
            headerColor1, headerColor2,
        });

        const transporter = createTransport();
        const autoSubject = `Your ${storeName} Catalog${couponCode ? ' — Special Coupon Inside 🎁' : ''}`;

        const attachments = pdfBase64 ? [{
            filename:    `${storeName.replace(/\s+/g, '-')}-Catalog.pdf`,
            content:     Buffer.from(pdfBase64, 'base64'),
            contentType: 'application/pdf',
        }] : [];

        const mailOptions = {
            from:    `"${storeName}" <noreply@autoinx.com>`,
            to:      toEmail,
            subject: subject || autoSubject,
            html:    emailHtml,
            attachments,
        };

        const info = await transporter.sendMail(mailOptions);
        console.log(`✅ Catalog sent: ${info.messageId}`);

        // Internal copy — no PDF attachment to keep inbox lean
        await transporter.sendMail({
            ...mailOptions,
            to:          'orders@autoinx.com',
            subject:     `[CATALOG SENT] → ${toEmail}${couponCode ? ` · Coupon: ${couponCode}` : ''}`,
            attachments: [],
        });

        // Log to Firestore
        try {
            await db.collection('email_notifications').add({
                type:           'catalog_sent',
                recipientEmail: toEmail,
                recipientName:  toName,
                couponCode:     couponCode || null,
                attachedPdf:    !!pdfBase64,
                localNote,
                sentBy:         adminEmail || 'admin',
                messageId:      info.messageId,
                sentAt:         admin.firestore.FieldValue.serverTimestamp(),
                status:         'sent',
            });
        } catch (logErr) {
            console.warn('⚠️ Firestore log failed:', logErr.message);
        }

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ success: true, messageId: info.messageId, pdfAttached: !!pdfBase64 }),
        };

    } catch (err) {
        console.error('❌ sendCatalogEmail error:', err);
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ success: false, error: err.message }),
        };
    }
};
