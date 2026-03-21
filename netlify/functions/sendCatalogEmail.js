const nodemailer = require('nodemailer');
const admin      = require('firebase-admin');

// ── Firebase init ──────────────────────────────────────────────────────────────
function getDb() {
    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId:   process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            }),
        });
    }
    return admin.firestore();
}

// ── Auth helper ────────────────────────────────────────────────────────────────
async function verifyIdToken(authHeader) {
    if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing auth token');
    const token = authHeader.slice(7);
    const auth  = admin.auth();
    return auth.verifyIdToken(token); // throws if invalid
}

// ── Email transporter ──────────────────────────────────────────────────────────
function createTransport() {
    // Supports either SMTP credentials or SendGrid/Mailgun via SMTP
    if (process.env.SMTP_HOST) {
        return nodemailer.createTransporter({
            host:   process.env.SMTP_HOST,
            port:   parseInt(process.env.SMTP_PORT || '587'),
            secure: process.env.SMTP_SECURE === 'true',
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS,
            },
        });
    }
    // SendGrid shorthand
    if (process.env.SENDGRID_API_KEY) {
        return nodemailer.createTransporter({
            host:   'smtp.sendgrid.net',
            port:   587,
            secure: false,
            auth: { user: 'apikey', pass: process.env.SENDGRID_API_KEY },
        });
    }
    throw new Error('No email transport configured. Set SMTP_HOST or SENDGRID_API_KEY.');
}

// ── PDF generation via puppeteer ──────────────────────────────────────────────
async function generateCatalogPdf(htmlContent) {
    try {
        // Try to use puppeteer-core + @sparticuz/chromium (Netlify-compatible)
        const chromium  = require('@sparticuz/chromium');
        const puppeteer = require('puppeteer-core');

        const browser = await puppeteer.launch({
            args:            chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath:  await chromium.executablePath(),
            headless:        chromium.headless,
        });

        const page = await browser.newPage();
        await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
        const pdf = await page.pdf({
            format:         'Letter',
            printBackground: true,
            margin: { top: '0.3in', right: '0.3in', bottom: '0.3in', left: '0.3in' },
        });
        await browser.close();
        return pdf;
    } catch (err) {
        console.warn('⚠️  PDF generation skipped:', err.message);
        return null;
    }
}

// ── Email HTML builder ─────────────────────────────────────────────────────────
function buildEmailHtml({ toName, message, couponCode, couponLabel, localNote, storeName, logoUrl, siteUrl, categories }) {
    const greeting = toName && toName !== 'there' ? `Hi ${toName},` : 'Hi there,';
    const personalMsg = message
        ? `<p style="font-size:16px;color:#374151;margin:0 0 12px;">${message}</p>`
        : '';

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

    // Product items per category
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
                        <p style="margin:0;font-size:16px;font-weight:900;color:#6366f1;">$${item.price}</p>
                    </td>
                </tr>
            </table>`).join('');

        return `
            <tr>
                <td style="padding:0 32px 8px;">
                    <p style="margin:0 0 12px;font-size:11px;font-weight:800;color:#6366f1;text-transform:uppercase;letter-spacing:3px;border-bottom:2px solid #e0e7ff;padding-bottom:6px;">${cat.name}</p>
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

<!-- Card -->
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

    <!-- Header -->
    <tr>
        <td style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:32px;text-align:center;">
            ${logoUrl ? `<img src="${logoUrl}" height="48" style="display:block;margin:0 auto 12px;object-fit:contain;" onerror="this.style.display='none'">` : ''}
            <h1 style="margin:0 0 4px;font-size:28px;font-weight:900;color:#ffffff;letter-spacing:-0.5px;">${storeName}</h1>
            <p style="margin:0;font-size:14px;color:rgba(255,255,255,0.8);letter-spacing:1px;text-transform:uppercase;">Product Catalog</p>
        </td>
    </tr>

    <!-- Greeting -->
    <tr>
        <td style="padding:32px 32px 20px;">
            <h2 style="margin:0 0 12px;font-size:22px;font-weight:800;color:#1e1b4b;">${greeting}</h2>
            ${personalMsg}
            <p style="margin:0;font-size:15px;color:#4b5563;line-height:1.7;">
                We're excited to share our latest product catalog with you. Browse our selection of quality auto parts
                and accessories below — and don't hesitate to reach out if you have any questions or need help finding
                the right part for your vehicle.
            </p>
        </td>
    </tr>

    <!-- Local delivery note -->
    ${localSection}

    <!-- Coupon -->
    ${couponSection}

    <!-- Divider -->
    <tr><td style="padding:0 32px 20px;">
        <hr style="border:none;border-top:2px solid #f3f4f6;margin:0;">
        <p style="margin:16px 0 0;font-size:20px;font-weight:800;color:#1e1b4b;">🛒 Our Products</p>
    </td></tr>

    <!-- Products by category -->
    ${categoryBlocks}

    <!-- CTA -->
    <tr>
        <td style="padding:16px 32px 32px;text-align:center;">
            <a href="${siteUrl}" style="display:inline-block;background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;padding:14px 36px;border-radius:50px;box-shadow:0 4px 12px rgba(79,70,229,0.35);">
                Shop the Full Catalog →
            </a>
        </td>
    </tr>

    <!-- Footer -->
    <tr>
        <td style="background:#f8fafc;padding:24px 32px;border-top:1px solid #e5e7eb;text-align:center;">
            <p style="margin:0 0 6px;font-size:13px;color:#6b7280;">
                Questions? Email us at
                <a href="mailto:support@autoinx.com" style="color:#6366f1;text-decoration:none;font-weight:600;">support@autoinx.com</a>
                or call <a href="tel:+13412227912" style="color:#6366f1;text-decoration:none;font-weight:600;">341-222-7912</a>
            </p>
            <p style="margin:0;font-size:12px;color:#9ca3af;">
                <a href="${siteUrl}" style="color:#9ca3af;">${siteUrl}</a> · AutoInx Automotive Parts
            </p>
        </td>
    </tr>

</table>
<!-- /Card -->

</td></tr>
</table>

</body>
</html>`;
}

// ── PDF catalog HTML (print-optimized) ────────────────────────────────────────
function buildPdfHtml({ storeName, logoUrl, siteUrl, categories }) {
    const date = new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });

    const categoryBlocks = categories.map(cat => {
        const cards = cat.items.map(item => `
            <div class="card">
                ${item.imageUrl ? `<div class="card-img"><img src="${item.imageUrl}" alt="${item.name}" onerror="this.style.display='none'"></div>` : '<div class="card-img no-img">No Image</div>'}
                <div class="card-body">
                    <p class="card-name">${item.name}</p>
                    ${item.sku ? `<p class="sku">SKU: ${item.sku}</p>` : ''}
                    ${item.description ? `<p class="desc">${item.description}</p>` : ''}
                    <div class="card-footer">
                        <span class="price">$${item.price}</span>
                        <span class="stock">${item.stock} in stock</span>
                    </div>
                </div>
            </div>`).join('');

        return `
            <div class="category-section">
                <div class="category-header"><span>${cat.name.toUpperCase()}</span></div>
                <div class="grid">${cards}</div>
            </div>`;
    }).join('');

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>${storeName} — Product Catalog</title>
<style>
  @page { size: Letter; margin: 0.3in; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; background: #fff; color: #1f2937; -webkit-print-color-adjust: exact; print-color-adjust: exact; }

  /* Cover */
  .cover { height: 100vh; background: linear-gradient(135deg,#4f46e5,#7c3aed); display: flex; flex-direction: column; align-items: center; justify-content: center; color: #fff; page-break-after: always; }
  .cover img { width: 80px; height: 80px; object-fit: contain; border-radius: 16px; margin-bottom: 20px; }
  .cover h1 { font-size: 56px; font-weight: 900; letter-spacing: -1px; }
  .cover .sub { font-size: 18px; opacity: 0.8; letter-spacing: 4px; text-transform: uppercase; margin-top: 8px; }
  .cover .date { font-size: 14px; opacity: 0.6; margin-top: 16px; }
  .cover-contact { display: flex; gap: 24px; margin-top: 28px; flex-wrap: wrap; justify-content: center; }
  .cover-contact a { color: rgba(255,255,255,0.85); font-size: 13px; text-decoration: none; }

  /* Page header */
  .page-header { display: flex; align-items: center; justify-content: space-between; padding-bottom: 10px; border-bottom: 2px solid #e5e7eb; margin-bottom: 20px; }
  .page-header .brand { display: flex; align-items: center; gap: 8px; }
  .page-header img { width: 28px; height: 28px; object-fit: contain; border-radius: 6px; }
  .page-header .name { font-size: 18px; font-weight: 900; color: #6366f1; }
  .page-header .meta { font-size: 13px; color: #9ca3af; }

  /* Categories */
  .category-section { margin-bottom: 28px; }
  .category-header { text-align: center; margin-bottom: 14px; }
  .category-header span { font-size: 13px; font-weight: 800; color: #6366f1; letter-spacing: 3px; background: #f0f0ff; padding: 4px 18px; border-radius: 20px; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  .card { border: 1px solid #e5e7eb; border-radius: 10px; overflow: hidden; break-inside: avoid; }
  .card-img { height: 110px; background: #f9fafb; display: flex; align-items: center; justify-content: center; overflow: hidden; }
  .card-img img { max-width: 100%; max-height: 100%; object-fit: contain; }
  .no-img { font-size: 11px; color: #9ca3af; text-transform: uppercase; letter-spacing: 1px; }
  .card-body { padding: 10px 12px; }
  .card-name { font-size: 13px; font-weight: 700; color: #1e1b4b; margin-bottom: 3px; line-height: 1.3; }
  .sku { font-size: 10px; color: #9ca3af; font-family: monospace; margin-bottom: 4px; }
  .desc { font-size: 11px; color: #4b5563; line-height: 1.5; margin-bottom: 8px; }
  .card-footer { display: flex; align-items: center; justify-content: space-between; border-top: 1px solid #f3f4f6; padding-top: 8px; margin-top: auto; }
  .price { font-size: 16px; font-weight: 900; color: #6366f1; }
  .stock { font-size: 10px; color: #9ca3af; }

  /* Footer */
  .page-footer { margin-top: 24px; padding-top: 10px; border-top: 1px solid #e5e7eb; display: flex; justify-content: space-between; font-size: 10px; color: #9ca3af; }
</style>
</head>
<body>

<!-- Cover -->
<div class="cover">
    ${logoUrl ? `<img src="${logoUrl}" alt="${storeName}" onerror="this.style.display='none'">` : ''}
    <h1>${storeName}</h1>
    <p class="sub">Product Catalog</p>
    <p class="date">${date}</p>
    <div class="cover-contact">
        <a href="${siteUrl}">${siteUrl}</a>
        <a href="mailto:support@autoinx.com">support@autoinx.com</a>
        <a href="tel:+13412227912">341-222-7912</a>
    </div>
</div>

<!-- Content -->
<div class="content">
    <div class="page-header">
        <div class="brand">
            ${logoUrl ? `<img src="${logoUrl}" alt="${storeName}" onerror="this.style.display='none'">` : ''}
            <span class="name">${storeName}</span>
        </div>
        <span class="meta">Product Catalog · ${date}</span>
    </div>

    ${categoryBlocks}

    <div class="page-footer">
        <span>${siteUrl} · support@autoinx.com · 341-222-7912</span>
        <span>${storeName} · ${date}</span>
    </div>
</div>

</body>
</html>`;
}

// ── Handler ────────────────────────────────────────────────────────────────────
exports.handler = async function(event) {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    try {
        // Verify admin token
        await verifyIdToken(event.headers['authorization']);

        const {
            toEmail, toName = 'there', message = '', couponCode, couponLabel,
            attachPdf = true, localNote = true, storeName = 'AutoInx',
            logoUrl, siteUrl = 'https://autoinx.com', categories = [], adminEmail
        } = JSON.parse(event.body);

        if (!toEmail) throw new Error('toEmail is required');
        if (categories.length === 0) throw new Error('No products to include in catalog');

        console.log(`📧 Sending catalog to ${toEmail} (${categories.length} categories, attachPdf=${attachPdf})`);

        // Build email HTML
        const emailHtml = buildEmailHtml({ toName, message, couponCode, couponLabel, localNote, storeName, logoUrl, siteUrl, categories });

        // Build PDF if requested
        let pdfBuffer = null;
        if (attachPdf) {
            const pdfHtml = buildPdfHtml({ storeName, logoUrl, siteUrl, categories });
            pdfBuffer     = await generateCatalogPdf(pdfHtml);
        }

        // Send email
        const transporter = createTransport();
        const fromName    = storeName;
        const fromEmail   = process.env.EMAIL_FROM || 'catalog@autoinx.com';

        const mailOptions = {
            from:    `"${fromName}" <${fromEmail}>`,
            to:      toEmail,
            subject: `Your ${storeName} Catalog${couponCode ? ` — Special Coupon Inside 🎁` : ''}`,
            html:    emailHtml,
            attachments: pdfBuffer ? [{
                filename:    `${storeName.replace(/\s+/g,'-')}-Catalog.pdf`,
                content:     pdfBuffer,
                contentType: 'application/pdf',
            }] : [],
        };

        const info = await transporter.sendMail(mailOptions);
        console.log(`✅ Catalog sent: ${info.messageId}`);

        // Log to Firestore
        try {
            const db = getDb();
            await db.collection('email_notifications').add({
                type:           'catalog_sent',
                recipientEmail: toEmail,
                recipientName:  toName,
                couponCode:     couponCode || null,
                attachedPdf:    !!pdfBuffer,
                localNote,
                sentBy:         adminEmail || 'admin',
                messageId:      info.messageId,
                sentAt:         admin.firestore.FieldValue.serverTimestamp(),
                status:         'sent',
            });
        } catch (logErr) {
            console.warn('⚠️  Failed to log to Firestore:', logErr.message);
        }

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ success: true, messageId: info.messageId, pdfAttached: !!pdfBuffer }),
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
