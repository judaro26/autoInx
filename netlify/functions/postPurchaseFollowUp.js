/**
 * Netlify Function: postPurchaseFollowUp.js
 *
 * Cron schedule: runs daily at 09:00 UTC ("0 9 * * *")
 *
 * Sends two post-purchase emails:
 *   - 7 days after delivery: review request
 *   - 30 days after delivery: loyalty discount code
 *
 * Tracks sent emails in Firestore under `post_purchase_emails/{orderId}_{type}`
 * so each email is never sent twice.
 */

const admin    = require('firebase-admin');
const nodemailer = require('nodemailer');

function initAdmin() {
    if (admin.apps.length === 0) {
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

function getTransporter() {
    return nodemailer.createTransport({
        host:   process.env.BREVO_SMTP_HOST,
        port:   parseInt(process.env.BREVO_SMTP_PORT || '587'),
        secure: false,
        auth: { user: process.env.BREVO_SMTP_USER, pass: process.env.BREVO_SMTP_PASSWORD },
    });
}

function formatPrice(cents) {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

const STORE_URL  = 'https://autoinx.com';
const REVIEW_URL = 'https://autoinx.com/?tab=reviews';

// ── Email builders ────────────────────────────────────────────────────────────

function buildReviewEmail(order) {
    const name  = order.buyerName?.split(' ')[0] || 'there';
    const isEs  = (order.communicationLang || order.language || 'en') === 'es';
    const items = (order.items || []).slice(0, 3);

    const itemList = items.map(i =>
        `<li style="padding:6px 0;font-size:14px;color:#374151;">• ${i.name}</li>`
    ).join('');

    const subject = isEs
        ? `¿Cómo te fue con tu pedido? — autoInx`
        : `How was your order? — autoInx`;

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:40px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:600px;">
  <tr><td style="background:linear-gradient(135deg,#6366f1,#4f46e5);padding:32px 40px;text-align:center;">
    <h1 style="color:#fff;margin:0;font-size:26px;font-weight:700;">autoInx</h1>
  </td></tr>
  <tr><td style="padding:36px 40px;">
    <h2 style="font-size:22px;color:#1e293b;margin:0 0 12px;">
      ${isEs ? `⭐ ¿Qué tal tu experiencia, ${name}?` : `⭐ How was your experience, ${name}?`}
    </h2>
    <p style="font-size:15px;color:#64748b;line-height:1.6;margin:0 0 20px;">
      ${isEs
        ? `Han pasado 7 días desde que recibiste tu pedido y queremos saber cómo te fue. Tu opinión nos ayuda a mejorar.`
        : `It's been a week since your order arrived — we'd love to hear how everything went. Your feedback helps us serve you better.`}
    </p>
    ${itemList ? `
    <div style="background:#f8fafc;border-radius:10px;padding:16px;margin-bottom:20px;">
      <p style="font-size:13px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:1px;margin:0 0 8px;">
        ${isEs ? 'Tu pedido' : 'Your order'}
      </p>
      <ul style="margin:0;padding:0;list-style:none;">${itemList}</ul>
    </div>` : ''}
    <div style="text-align:center;margin:28px 0;">
      <a href="${REVIEW_URL}"
         style="display:inline-block;background:linear-gradient(135deg,#6366f1,#4f46e5);color:#fff;padding:14px 36px;border-radius:10px;font-weight:700;font-size:16px;text-decoration:none;">
        ${isEs ? '⭐ Dejar una reseña' : '⭐ Leave a review'}
      </a>
    </div>
    <p style="font-size:13px;color:#94a3b8;text-align:center;margin:0;">
      ${isEs
        ? '¡Tu opinión significa mucho para nosotros!'
        : 'Your feedback means a lot to us — thank you!'}
    </p>
  </td></tr>
  <tr><td style="background:#1e293b;padding:20px 40px;text-align:center;">
    <p style="color:#94a3b8;font-size:12px;margin:0;">© ${new Date().getFullYear()} autoInx · <a href="${STORE_URL}" style="color:#818cf8;">autoinx.com</a></p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

    return { subject, html };
}

function buildDiscountEmail(order, discountCode, discountLabel) {
    const name = order.buyerName?.split(' ')[0] || 'there';
    const isEs = (order.communicationLang || order.language || 'en') === 'es';

    const subject = isEs
        ? `Un regalo para ti — ${discountLabel} en autoInx 🎁`
        : `A gift for you — ${discountLabel} at autoInx 🎁`;

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:40px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:600px;">
  <tr><td style="background:linear-gradient(135deg,#6366f1,#4f46e5);padding:32px 40px;text-align:center;">
    <h1 style="color:#fff;margin:0;font-size:26px;font-weight:700;">autoInx</h1>
  </td></tr>
  <tr><td style="padding:36px 40px;text-align:center;">
    <div style="font-size:48px;margin-bottom:16px;">🎁</div>
    <h2 style="font-size:22px;color:#1e293b;margin:0 0 12px;">
      ${isEs ? `¡Gracias por tu confianza, ${name}!` : `Thank you for your loyalty, ${name}!`}
    </h2>
    <p style="font-size:15px;color:#64748b;line-height:1.6;margin:0 0 28px;">
      ${isEs
        ? `Ha pasado un mes desde tu último pedido y queremos agradecerte con un descuento exclusivo para tu próxima compra.`
        : `It's been a month since your last order and we want to thank you with an exclusive discount on your next purchase.`}
    </p>
    <div style="background:linear-gradient(135deg,#eff6ff,#f0fdf4);border:2px dashed #6366f1;border-radius:14px;padding:28px;margin-bottom:28px;">
      <p style="font-size:13px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:2px;margin:0 0 10px;">
        ${isEs ? 'Tu código exclusivo' : 'Your exclusive code'}
      </p>
      <p style="font-size:32px;font-weight:900;font-family:monospace;color:#4f46e5;letter-spacing:4px;margin:0 0 8px;background:#fff;display:inline-block;padding:10px 24px;border-radius:8px;border:1px solid #c7d2fe;">
        ${discountCode}
      </p>
      <p style="font-size:18px;font-weight:700;color:#16a34a;margin:12px 0 0;">
        ${discountLabel}
      </p>
    </div>
    <a href="${STORE_URL}"
       style="display:inline-block;background:linear-gradient(135deg,#6366f1,#4f46e5);color:#fff;padding:14px 36px;border-radius:10px;font-weight:700;font-size:16px;text-decoration:none;">
      ${isEs ? '🛒 Ir a la tienda' : '🛒 Shop now'}
    </a>
    <p style="font-size:12px;color:#94a3b8;margin:20px 0 0;">
      ${isEs ? 'Código válido por 30 días.' : 'Code valid for 30 days.'}
    </p>
  </td></tr>
  <tr><td style="background:#1e293b;padding:20px 40px;text-align:center;">
    <p style="color:#94a3b8;font-size:12px;margin:0;">© ${new Date().getFullYear()} autoInx · <a href="${STORE_URL}" style="color:#818cf8;">autoinx.com</a></p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

    return { subject, html };
}

// ── Main handler ──────────────────────────────────────────────────────────────


// ── Dead-letter alert helper ─────────────────────────────────────────────────
async function alertCronFailure(functionName, error, transporter) {
    try {
        await transporter.sendMail({
            from:    '"autoInx Alerts" <noreply@autoinx.com>',
            to:      process.env.ADMIN_EMAIL || 'orders@autoinx.com',
            subject: `🚨 Cron failure: ${functionName}`,
            html: `<p>The scheduled function <strong>${functionName}</strong> failed at ${new Date().toUTCString()}.</p>
                   <pre style="background:#f3f4f6;padding:12px;border-radius:8px;">${error?.stack || error?.message || String(error)}</pre>
                   <p>Check Netlify function logs for details.</p>`,
        });
    } catch (mailErr) {
        console.error('Dead-letter alert failed:', mailErr.message);
    }
}

exports.handler = async function () {
    try {
    const db          = initAdmin();
    const transporter = getTransporter();
    const now         = new Date();

    // Windows: delivered 6-8 days ago (7-day review) and 29-31 days ago (30-day discount)
    const day7start  = new Date(now - 8 * 864e5).toISOString();
    const day7end    = new Date(now - 6 * 864e5).toISOString();
    const day30start = new Date(now - 31 * 864e5).toISOString();
    const day30end   = new Date(now - 29 * 864e5).toISOString();

    let sent7 = 0, sent30 = 0, errors = 0;

    // ── 7-day review requests ─────────────────────────────────────────────────
    // IMPORTANT: Requires a Firestore composite index on:
    //   Collection: artifacts/default-app-id/public/data/orders
    //   Fields: status (Ascending), updatedAt (Ascending)
    // Create it at: Firebase Console → Firestore → Indexes → Add composite index
    // Without this index, the query returns 0 results silently.
    let snap7 = { docs: [] };
    try {
        snap7 = await db
            .collection('artifacts/default-app-id/public/data/orders')
            .where('status', '==', 'Delivered')
            .where('updatedAt', '>=', admin.firestore.Timestamp.fromDate(new Date(day7start)))
            .where('updatedAt', '<=', admin.firestore.Timestamp.fromDate(new Date(day7end)))
            .get();
    } catch (indexErr) {
        if (indexErr.code === 9 || indexErr.message?.includes('index')) {
            console.error('⚠️ Missing Firestore composite index for (status, updatedAt). Create it in Firebase Console → Indexes.');
        } else {
            throw indexErr;
        }
    }

    for (const docSnap of snap7.docs) {
        const order = { id: docSnap.id, ...docSnap.data() };
        if (!order.buyerEmail) continue;

        const sentKey = `post_purchase_emails/${order.id}_review`;
        const alreadySent = await db.doc(sentKey).get().then(s => s.exists).catch(() => false);
        if (alreadySent) continue;

        try {
            const { subject, html } = buildReviewEmail(order);
            await transporter.sendMail({
                from: '"autoInx" <noreply@autoinx.com>',
                to:   order.buyerEmail,
                subject, html,
            });
            await db.doc(sentKey).set({ sentAt: admin.firestore.FieldValue.serverTimestamp(), orderId: order.id, type: 'review' });
            sent7++;
            console.log(`✅ Review email sent to ${order.buyerEmail} (order ${order.id.slice(0,8)})`);
        } catch (err) {
            console.error(`❌ Review email failed for ${order.id.slice(0,8)}:`, err.message);
            errors++;
        }
    }

    // ── 30-day discount emails ────────────────────────────────────────────────
    // Find a discount code tagged for follow-up, or generate a fixed one
    let discountCode  = 'THANKYOU10';
    let discountLabel = '10% OFF your next order';
    try {
        const discSnap = await db
            .collection('discounts')
            .where('followUp', '==', true)
            .where('enabled',  '==', true)
            .limit(1).get();
        if (!discSnap.empty) {
            const d = discSnap.docs[0].data();
            discountCode  = d.code;
            discountLabel = d.type === 'percentage' ? `${d.value}% OFF` : `$${d.value} OFF`;
        }
    } catch {}

    let snap30 = { docs: [] };
    try {
        snap30 = await db
            .collection('artifacts/default-app-id/public/data/orders')
            .where('status', '==', 'Delivered')
            .where('updatedAt', '>=', admin.firestore.Timestamp.fromDate(new Date(day30start)))
            .where('updatedAt', '<=', admin.firestore.Timestamp.fromDate(new Date(day30end)))
            .get();
    } catch (indexErr) {
        if (indexErr.code === 9 || indexErr.message?.includes('index')) {
            console.error('⚠️ Missing Firestore composite index. Skipping 30-day query.');
        } else {
            snap30 = { docs: [] };
        }
    }

    for (const docSnap of snap30.docs) {
        const order = { id: docSnap.id, ...docSnap.data() };
        if (!order.buyerEmail) continue;

        const sentKey = `post_purchase_emails/${order.id}_discount`;
        const alreadySent = await db.doc(sentKey).get().then(s => s.exists).catch(() => false);
        if (alreadySent) continue;

        try {
            const { subject, html } = buildDiscountEmail(order, discountCode, discountLabel);
            await transporter.sendMail({
                from: '"autoInx" <noreply@autoinx.com>',
                to:   order.buyerEmail,
                subject, html,
            });
            await db.doc(sentKey).set({ sentAt: admin.firestore.FieldValue.serverTimestamp(), orderId: order.id, type: 'discount', code: discountCode, source: 'postPurchaseFollowup' });
            sent30++;
            console.log(`✅ Discount email sent to ${order.buyerEmail} (order ${order.id.slice(0,8)})`);
        } catch (err) {
            console.error(`❌ Discount email failed for ${order.id.slice(0,8)}:`, err.message);
            errors++;
        }
    }

    console.log(`📬 Post-purchase follow-up: ${sent7} review emails, ${sent30} discount emails, ${errors} errors`);
    return { statusCode: 200, body: JSON.stringify({ sent7, sent30, er
    } catch (err) {
        console.error(`❌ ${__filename.split('/').pop()} fatal error:`, err);
        const t = getTransporter();
        await alertCronFailure(__filename.split('/').pop(), err, t).catch(() => {});
        return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
rors }) };
};
