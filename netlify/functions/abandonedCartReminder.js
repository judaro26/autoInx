/**
 * abandonedCartReminder.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Netlify Scheduled Function — runs every day at 10:00 AM UTC
 *
 * What it does:
 *   1. Queries Firestore for orders that are Pending + Unpaid and were created
 *      between REMINDER_MIN_HOURS and REMINDER_MAX_HOURS ago.
 *   2. Skips orders that already received a reminder (reminderSentAt is set).
 *   3. Sends a bilingual (EN/ES) HTML reminder email via Nodemailer/Gmail SMTP
 *      with the original Stripe payment link embedded.
 *   4. Stamps `reminderSentAt` on the Firestore doc so it's never re-sent.
 *
 * Required Netlify environment variables:
 *   FIREBASE_PROJECT_ID
 *   FIREBASE_CLIENT_EMAIL
 *   FIREBASE_PRIVATE_KEY          (newline-escaped as \n)
 *   EMAIL_USER                    (Gmail address, e.g. orders@autoinx.com)
 *   EMAIL_PASS                    (Gmail App Password — NOT your regular password)
 *   SITE_URL                      (https://autoinx.com)
 *
 * Optional:
 *   REMINDER_MIN_HOURS            (default: 1  — don't remind before 1h)
 *   REMINDER_MAX_HOURS            (default: 48 — don't remind after 48h)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const admin      = require('firebase-admin');
const nodemailer = require('nodemailer');

// ── Config ──────────────────────────────────────────────────────────────────
const REMINDER_MIN_HOURS = parseInt(process.env.REMINDER_MIN_HOURS || '1',  10);
const REMINDER_MAX_HOURS = parseInt(process.env.REMINDER_MAX_HOURS || '48', 10);
const SITE_URL           = (process.env.SITE_URL || 'https://autoinx.com').replace(/\/$/, '');
const ORDERS_PATH        = 'artifacts/default-app-id/public/data/orders';

// ── Firebase Admin (lazy-init, same pattern as stripeWebhook.js) ─────────────
function getDb() {
    if (admin.apps.length === 0) {
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId  : process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey : process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            }),
        });
    }
    return admin.firestore();
}

// ── Nodemailer transporter (Gmail SMTP) ──────────────────────────────────────
function getTransporter() {
    return nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS,   // Gmail App Password
        },
    });
}

// ── Utility ──────────────────────────────────────────────────────────────────
function formatPrice(cents) {
    return '$' + (cents / 100).toFixed(2);
}

function detectLang(order) {
    // Prefer explicit communicationLang, then fall back to a heuristic
    if (order.communicationLang === 'es') return 'es';
    if (order.language           === 'es') return 'es';
    return 'en';
}

// ── Email HTML builder ───────────────────────────────────────────────────────
function buildEmailHtml({ order, orderId, lang }) {
    const isEs      = lang === 'es';
    const firstName = (order.buyerName || order.buyerEmail || '').split(/\s|@/)[0];
    const payUrl    = order.stripePaymentUrl || `${SITE_URL}/checkout.html`;
    const logoUrl   = `${SITE_URL}/images/AutoInx%20logo.png`;

    const itemRows = (order.items || []).map(item => `
        <tr>
            <td style="padding:8px 12px;font-size:13px;color:#374151;border-bottom:1px solid #f3f4f6;">
                ${item.name}${item.sku ? ` <span style="color:#9ca3af;font-size:11px;">(${item.sku})</span>` : ''}
            </td>
            <td style="padding:8px 12px;text-align:center;font-size:13px;color:#374151;border-bottom:1px solid #f3f4f6;">
                ×${item.quantity}
            </td>
            <td style="padding:8px 12px;text-align:right;font-size:13px;font-weight:600;color:#374151;border-bottom:1px solid #f3f4f6;">
                ${formatPrice(item.price * item.quantity)}
            </td>
        </tr>`).join('');

    const subtotal = formatPrice(order.subtotalCents  || 0);
    const shipping = formatPrice(order.shippingCents  || 0);
    const tax      = formatPrice(order.taxCents       || 0);
    const total    = formatPrice(order.totalCents     || 0);

    /* ── Copy ── */
    const copy = {
        subject  : isEs ? '🛒 Tienes artículos esperándote en AutoInx'
                        : '🛒 You left something in your cart at AutoInx',
        preheader: isEs ? 'Tu pedido está casi listo — completa tu pago ahora.'
                        : 'Your order is almost ready — complete your payment now.',
        greeting : isEs ? `Hola ${firstName},`
                        : `Hi ${firstName},`,
        body1    : isEs ? 'Notamos que dejaste artículos en tu carrito de AutoInx. Tu pedido está reservado y tu enlace de pago sigue activo — solo tienes que completar el pago.'
                        : 'You left some items in your AutoInx cart. Your order is reserved and your payment link is still active — just complete your payment to confirm it.',
        cartTitle: isEs ? 'Tu Carrito' : 'Your Cart',
        itemCol  : isEs ? 'Producto'   : 'Product',
        qtyCol   : isEs ? 'Cant.'      : 'Qty',
        priceCol : isEs ? 'Precio'     : 'Price',
        subtotalL: isEs ? 'Subtotal'   : 'Subtotal',
        shippingL: isEs ? 'Envío'      : 'Shipping',
        taxL     : isEs ? 'Impuesto'   : 'Tax',
        totalL   : isEs ? 'Total'      : 'Total',
        ctaBtn   : isEs ? 'Completar Pago →' : 'Complete My Order →',
        helpTitle: isEs ? '¿Necesitas ayuda?' : 'Need help?',
        helpBody : isEs ? 'Si tienes preguntas sobre compatibilidad o envío, escríbenos a '
                        : "If you have questions about fitment or shipping, reach us at ",
        expiry   : isEs ? 'Este enlace de pago es válido por tiempo limitado. Si expira, contáctanos y te enviaremos uno nuevo.'
                        : 'This payment link is valid for a limited time. If it expires, contact us and we\'ll send a fresh one.',
        footer   : isEs ? '© 2026 AutoInx · 587 Paradise Blvd, Hayward CA 94541 · Operación Familiar'
                        : '© 2026 AutoInx · 587 Paradise Blvd, Hayward CA 94541 · Family-Owned Operation',
        unsubL   : isEs ? 'Para dejar de recibir estos correos, responde con "cancelar".'
                        : 'To stop receiving these reminders, reply with "unsubscribe".',
    };

    return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${copy.subject}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Helvetica Neue',Arial,sans-serif;">

<!-- Preheader (hidden preview text) -->
<span style="display:none;max-height:0;overflow:hidden;">${copy.preheader}</span>

<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 16px;">
  <tr><td align="center">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

      <!-- ── Header ── -->
      <tr>
        <td style="background:linear-gradient(135deg,#4338ca 0%,#6366f1 100%);padding:28px 32px;text-align:center;">
          <img src="${logoUrl}" alt="AutoInx" height="40"
               style="height:40px;width:auto;margin-bottom:10px;display:block;margin-left:auto;margin-right:auto;">
          <p style="margin:0;color:#c7d2fe;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;font-weight:600;">
            ${isEs ? 'Recordatorio de Carrito' : 'Cart Reminder'}
          </p>
        </td>
      </tr>

      <!-- ── Body ── -->
      <tr>
        <td style="padding:32px 32px 24px;">
          <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#1e1b4b;line-height:1.3;">
            ${copy.greeting}
          </h1>
          <p style="margin:0 0 24px;font-size:15px;color:#4b5563;line-height:1.7;">
            ${copy.body1}
          </p>

          <!-- Cart table -->
          <p style="margin:0 0 8px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#6b7280;">
            ${copy.cartTitle}
          </p>
          <table width="100%" cellpadding="0" cellspacing="0"
                 style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;margin-bottom:16px;">
            <thead>
              <tr style="background:#f9fafb;">
                <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;color:#9ca3af;">${copy.itemCol}</th>
                <th style="padding:8px 12px;text-align:center;font-size:11px;font-weight:700;text-transform:uppercase;color:#9ca3af;">${copy.qtyCol}</th>
                <th style="padding:8px 12px;text-align:right;font-size:11px;font-weight:700;text-transform:uppercase;color:#9ca3af;">${copy.priceCol}</th>
              </tr>
            </thead>
            <tbody>${itemRows}</tbody>
          </table>

          <!-- Totals -->
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
            <tr>
              <td style="font-size:13px;color:#6b7280;padding:3px 0;">${copy.subtotalL}</td>
              <td style="font-size:13px;color:#374151;text-align:right;padding:3px 0;">${subtotal}</td>
            </tr>
            ${(order.shippingCents || 0) > 0 ? `
            <tr>
              <td style="font-size:13px;color:#6b7280;padding:3px 0;">${copy.shippingL}</td>
              <td style="font-size:13px;color:#374151;text-align:right;padding:3px 0;">${shipping}</td>
            </tr>` : ''}
            ${(order.taxCents || 0) > 0 ? `
            <tr>
              <td style="font-size:13px;color:#6b7280;padding:3px 0;">${copy.taxL}</td>
              <td style="font-size:13px;color:#374151;text-align:right;padding:3px 0;">${tax}</td>
            </tr>` : ''}
            <tr style="border-top:2px solid #e5e7eb;">
              <td style="font-size:15px;font-weight:800;color:#1e1b4b;padding:8px 0 0;">${copy.totalL}</td>
              <td style="font-size:18px;font-weight:900;color:#ec4899;text-align:right;padding:8px 0 0;">${total}</td>
            </tr>
          </table>

          <!-- CTA Button -->
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
            <tr>
              <td align="center">
                <a href="${payUrl}"
                   style="display:inline-block;background:linear-gradient(135deg,#ec4899,#f43f5e);color:#ffffff;font-size:16px;font-weight:800;padding:16px 40px;border-radius:12px;text-decoration:none;letter-spacing:0.02em;box-shadow:0 4px 14px rgba(236,72,153,0.35);">
                  ${copy.ctaBtn}
                </a>
              </td>
            </tr>
          </table>

          <!-- Expiry note -->
          <p style="margin:0 0 20px;font-size:12px;color:#9ca3af;text-align:center;line-height:1.6;">
            ⏱ ${copy.expiry}
          </p>

          <!-- Help section -->
          <div style="background:#f8fafc;border-radius:10px;padding:16px 20px;border:1px solid #e2e8f0;">
            <p style="margin:0 0 4px;font-size:13px;font-weight:700;color:#374151;">${copy.helpTitle}</p>
            <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.6;">
              ${copy.helpBody}
              <a href="mailto:orders@autoinx.com" style="color:#6366f1;font-weight:600;">orders@autoinx.com</a>
            </p>
          </div>
        </td>
      </tr>

      <!-- ── Footer ── -->
      <tr>
        <td style="background:#f9fafb;padding:20px 32px;border-top:1px solid #f3f4f6;text-align:center;">
          <p style="margin:0 0 6px;font-size:11px;color:#9ca3af;">${copy.footer}</p>
          <p style="margin:0;font-size:11px;color:#d1d5db;">${copy.unsubL}</p>
        </td>
      </tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

// ── Main handler ─────────────────────────────────────────────────────────────
exports.handler = async function(event) {
    console.log('🛒 abandonedCartReminder: starting run at', new Date().toISOString());

    const db          = getDb();
    const transporter = getTransporter();

    const now      = Date.now();
    const minMs    = REMINDER_MIN_HOURS * 60 * 60 * 1000;
    const maxMs    = REMINDER_MAX_HOURS * 60 * 60 * 1000;
    const minCutoff = new Date(now - maxMs);   // oldest order we still care about
    const maxCutoff = new Date(now - minMs);   // newest order eligible for reminder

    let scanned = 0, sent = 0, skipped = 0, errors = 0;

    try {
        // ── 1. Query for Pending + Unpaid orders in the time window ──────────
        const snapshot = await db
            .collection(ORDERS_PATH)
            .where('paymentStatus', '==', 'Unpaid')
            .where('status',        '==', 'Pending')
            .where('createdAt',     '>=', admin.firestore.Timestamp.fromDate(minCutoff))
            .where('createdAt',     '<=', admin.firestore.Timestamp.fromDate(maxCutoff))
            .get();

        scanned = snapshot.size;
        console.log(`📋 Found ${scanned} candidate order(s) in window.`);

        // ── 2. Process each order ────────────────────────────────────────────
        for (const docSnap of snapshot.docs) {
            const order   = docSnap.data();
            const orderId = docSnap.id;

            // Skip if we already sent a reminder
            if (order.reminderSentAt) {
                console.log(`⏭  Skipping ${orderId} — reminder already sent.`);
                skipped++;
                continue;
            }

            // Skip if no email address
            if (!order.buyerEmail) {
                console.warn(`⚠️  Skipping ${orderId} — no buyerEmail.`);
                skipped++;
                continue;
            }

            const lang = detectLang(order);
            const html = buildEmailHtml({ order, orderId, lang });
            const subject = lang === 'es'
                ? '🛒 Tienes artículos esperándote en AutoInx'
                : '🛒 You left something in your cart at AutoInx';

            try {
                await transporter.sendMail({
                    from   : `"AutoInx" <${process.env.EMAIL_USER}>`,
                    to     : order.buyerEmail,
                    subject,
                    html,
                    // Plain-text fallback
                    text: lang === 'es'
                        ? `Hola, tienes artículos pendientes de pago en AutoInx. Completa tu pedido aquí: ${order.stripePaymentUrl || SITE_URL + '/checkout.html'}`
                        : `Hi, you have unpaid items at AutoInx. Complete your order here: ${order.stripePaymentUrl || SITE_URL + '/checkout.html'}`,
                });

                // ── 3. Stamp the order so we never re-send ────────────────
                await docSnap.ref.update({
                    reminderSentAt   : admin.firestore.FieldValue.serverTimestamp(),
                    reminderSentEmail: order.buyerEmail,
                });

                console.log(`✅ Reminder sent → ${order.buyerEmail} (order: ${orderId})`);
                sent++;

            } catch (emailErr) {
                console.error(`❌ Failed to send reminder for ${orderId}:`, emailErr.message);
                errors++;
            }

            // Small delay between sends to avoid Gmail rate limits
            await new Promise(r => setTimeout(r, 400));
        }

    } catch (queryErr) {
        console.error('❌ Firestore query failed:', queryErr.message);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: queryErr.message }),
        };
    }

    const summary = { scanned, sent, skipped, errors };
    console.log('🏁 abandonedCartReminder done:', summary);

    return {
        statusCode: 200,
        body: JSON.stringify(summary),
    };
};
