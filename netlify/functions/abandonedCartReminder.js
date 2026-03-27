/**
 * Netlify Function: abandonedCartReminder.js
 *
 * Handles two modes:
 *
 * 1. MANUAL (POST from admin panel) — sends a reminder to a specific cart.
 *    Requires a valid admin Firebase ID token in Authorization header.
 *    Body: { cartId, userEmail, manual: true }
 *
 * 2. CRON (scheduled at "0 10 * * *") — scans all carts abandoned for
 *    1–48 hours, skips any that already have reminderSent: true, and
 *    sends a reminder to each.
 *
 * Cart document shape (in `abandoned_carts/{userId}`):
 *   { userEmail, userName?, items: [{name, price, quantity, imageUrl?}],
 *     totalCents, itemCount, updatedAt, reminderSent?, reminderSentAt? }
 */

const admin      = require('firebase-admin');
const nodemailer = require('nodemailer');

const STORE_URL   = 'https://autoinx.com';
const STORE_NAME  = 'AutoInx';
const FROM_EMAIL  = 'noreply@autoinx.com';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'orders@autoinx.com';

// Carts abandoned for between 1 hour and 48 hours are eligible
const MIN_ABANDON_MS = 1  * 60 * 60 * 1000;   // 1 hour
const MAX_ABANDON_MS = 48 * 60 * 60 * 1000;   // 48 hours

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
        auth: {
            user: process.env.BREVO_SMTP_USER,
            pass: process.env.BREVO_SMTP_PASSWORD,
        },
    });
}

function formatPrice(cents) {
    return new Intl.NumberFormat('en-US', {
        style: 'currency', currency: 'USD', minimumFractionDigits: 2
    }).format((cents || 0) / 100);
}

function buildReminderEmail(cart, cartId) {
    const firstName = cart.userName?.split(' ')[0] || 'there';
    const items     = cart.items || [];
    const total     = formatPrice(cart.totalCents);

    // Item rows
    const itemRows = items.map(item => {
        const img   = item.imageUrl || item.imageUrls?.[0] || '';
        const price = formatPrice((item.price || 0) * (item.quantity || 1));
        return `
        <tr>
            <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;vertical-align:middle;">
                ${img ? `<img src="${img}" width="48" height="48" style="border-radius:6px;object-fit:contain;vertical-align:middle;margin-right:10px;" alt="">` : ''}
                <span style="font-size:14px;color:#1e293b;font-weight:600;">${item.name || 'Item'}</span>
                ${item.sku ? `<span style="font-size:11px;color:#94a3b8;display:block;margin-top:2px;">SKU: ${item.sku}</span>` : ''}
            </td>
            <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;text-align:center;font-size:13px;color:#64748b;">×${item.quantity || 1}</td>
            <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;text-align:right;font-size:14px;font-weight:700;color:#4f46e5;white-space:nowrap;">${price}</td>
        </tr>`;
    }).join('');

    const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:'Segoe UI',Roboto,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:40px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);max-width:600px;">

  <!-- Header -->
  <tr>
    <td style="background:linear-gradient(135deg,#6366f1,#4f46e5);padding:32px 40px;text-align:center;">
      <h1 style="color:#fff;margin:0 0 6px;font-size:26px;font-weight:700;">${STORE_NAME}</h1>
      <p style="color:rgba(255,255,255,.85);margin:0;font-size:15px;">You left something behind!</p>
    </td>
  </tr>

  <!-- Body -->
  <tr>
    <td style="padding:36px 40px;">

      <h2 style="font-size:22px;color:#1e293b;margin:0 0 12px;font-weight:700;">
        🛒 Hi ${firstName}, your cart misses you!
      </h2>
      <p style="font-size:15px;color:#64748b;line-height:1.6;margin:0 0 24px;">
        You left some great items in your cart. They're still waiting for you — 
        but stock is limited so don't wait too long!
      </p>

      <!-- Items table -->
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:24px;">
        <thead>
          <tr style="background:#f8fafc;">
            <th style="padding:10px 12px;text-align:left;font-size:12px;color:#6366f1;font-weight:700;text-transform:uppercase;letter-spacing:.5px;">Item</th>
            <th style="padding:10px 12px;text-align:center;font-size:12px;color:#6366f1;font-weight:700;text-transform:uppercase;letter-spacing:.5px;">Qty</th>
            <th style="padding:10px 12px;text-align:right;font-size:12px;color:#6366f1;font-weight:700;text-transform:uppercase;letter-spacing:.5px;">Price</th>
          </tr>
        </thead>
        <tbody>${itemRows}</tbody>
        <tfoot>
          <tr style="background:#f8fafc;border-top:2px solid #e2e8f0;">
            <td colspan="2" style="padding:12px;text-align:right;font-size:15px;font-weight:700;color:#1e293b;">Total:</td>
            <td style="padding:12px;text-align:right;font-size:18px;font-weight:900;color:#4f46e5;">${total}</td>
          </tr>
        </tfoot>
      </table>

      <!-- CTA -->
      <div style="text-align:center;margin:28px 0;">
        <a href="${STORE_URL}"
           style="display:inline-block;background:linear-gradient(135deg,#6366f1,#4f46e5);color:#ffffff;padding:15px 40px;border-radius:12px;font-weight:700;font-size:16px;text-decoration:none;box-shadow:0 4px 15px rgba(99,102,241,.35);">
          🛒 Complete My Order
        </a>
      </div>

      <p style="font-size:13px;color:#94a3b8;text-align:center;margin:0;">
        Questions? Reply to this email or visit <a href="${STORE_URL}" style="color:#6366f1;">${STORE_URL}</a>
      </p>
    </td>
  </tr>

  <!-- Footer -->
  <tr>
    <td style="background:#1e293b;padding:20px 40px;text-align:center;">
      <p style="color:#94a3b8;font-size:12px;margin:0;">
        © ${new Date().getFullYear()} ${STORE_NAME} · 
        You're receiving this because you added items to your cart.
      </p>
    </td>
  </tr>

</table>
</td></tr>
</table>
</body>
</html>`;

    return {
        subject: `🛒 ${firstName}, you left something in your cart!`,
        html,
    };
}

async function sendReminderForCart(db, transporter, cartId, cart) {
    const { subject, html } = buildReminderEmail(cart, cartId);

    await transporter.sendMail({
        from: `"${STORE_NAME}" <${FROM_EMAIL}>`,
        to:   cart.userEmail,
        subject,
        html,
    });

    // Mark as reminded
    await db.collection('abandoned_carts').doc(cartId).update({
        reminderSent:   true,
        reminderSentAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`✅ Reminder sent to ${cart.userEmail} (cart ${cartId.slice(0, 8)})`);
}

// ── Main handler ──────────────────────────────────────────────────────────────
exports.handler = async function (event) {
    const db          = initAdmin();
    const transporter = getTransporter();

    // ── MANUAL mode: triggered from admin panel ───────────────────────────────
    if (event.httpMethod === 'POST') {
        // Verify admin token
        const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
        const idToken    = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

        if (!idToken) {
            return { statusCode: 401, body: JSON.stringify({ error: 'Missing token' }) };
        }

        let decoded;
        try {
            decoded = await admin.auth().verifyIdToken(idToken);
        } catch {
            return { statusCode: 401, body: JSON.stringify({ error: 'Invalid token' }) };
        }

        if (!decoded.admin) {
            return { statusCode: 403, body: JSON.stringify({ error: 'Admin access required' }) };
        }

        let payload;
        try { payload = JSON.parse(event.body || '{}'); }
        catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

        const { cartId } = payload;
        if (!cartId) {
            return { statusCode: 400, body: JSON.stringify({ error: 'cartId required' }) };
        }

        const snap = await db.collection('abandoned_carts').doc(cartId).get();
        if (!snap.exists) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Cart not found' }) };
        }

        const cart = snap.data();
        if (!cart.userEmail) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Cart has no email address' }) };
        }

        try {
            await sendReminderForCart(db, transporter, cartId, cart);
            return {
                statusCode: 200,
                body: JSON.stringify({ success: true, sentTo: cart.userEmail }),
            };
        } catch (err) {
            console.error('Manual reminder error:', err);
            return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
        }
    }

    // ── CRON mode: scheduled daily scan ──────────────────────────────────────
    // (Netlify scheduled functions call the handler with no httpMethod or GET)
    const now    = Date.now();
    let sent = 0, skipped = 0, errors = 0;

    try {
        const snap = await db
            .collection('abandoned_carts')
            .where('reminderSent', '!=', true)
            .get();

        // Also catch carts where reminderSent field doesn't exist
        const allSnap = await db.collection('abandoned_carts').get();

        const eligible = allSnap.docs.filter(doc => {
            const cart = doc.data();
            if (cart.reminderSent) return false;                  // already reminded
            if (!cart.userEmail)   return false;                  // no email to send to
            if (!cart.items?.length) return false;                // empty cart

            const updatedAt = cart.updatedAt?.toDate?.()?.getTime?.() ||
                              (cart.updatedAt?._seconds ? cart.updatedAt._seconds * 1000 : null);
            if (!updatedAt) return false;

            const age = now - updatedAt;
            return age >= MIN_ABANDON_MS && age <= MAX_ABANDON_MS;
        });

        console.log(`📬 Abandoned cart cron: ${eligible.length} eligible carts`);

        for (const doc of eligible) {
            try {
                await sendReminderForCart(db, transporter, doc.id, doc.data());
                sent++;
            } catch (err) {
                console.error(`❌ Failed for cart ${doc.id.slice(0,8)}:`, err.message);
                errors++;
            }
        }

        console.log(`✅ Cron complete: ${sent} sent, ${skipped} skipped, ${errors} errors`);
        return { statusCode: 200, body: JSON.stringify({ sent, skipped, errors }) };

    } catch (err) {
        console.error('❌ Abandoned cart cron fatal error:', err);
        // Dead-letter alert
        try {
            await transporter.sendMail({
                from:    `"${STORE_NAME} Alerts" <${FROM_EMAIL}>`,
                to:      ADMIN_EMAIL,
                subject: '🚨 Cron failure: abandonedCartReminder',
                html:    `<p>Fatal error at ${new Date().toUTCString()}</p><pre>${err.stack || err.message}</pre>`,
            });
        } catch {}
        return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
};
