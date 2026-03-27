/**
 * Netlify Function: lowStockAlert.js
 *
 * Cron schedule: daily at 08:00 UTC ("0 8 * * *")
 *
 * Checks all catalog items for stock ≤ 10 and emails orders@autoinx.com
 * a digest of items that need restocking. Skips locked (temporarilyUnavailable)
 * items since those are already off sale.
 *
 * To avoid alert fatigue, each item is only re-alerted if its stock has
 * decreased since the last alert (tracked in Firestore under `low_stock_alerts`).
 */

const admin      = require('firebase-admin');
const nodemailer = require('nodemailer');

const LOW_STOCK_THRESHOLD = 10;
const ALERT_EMAIL         = process.env.ADMIN_EMAIL || 'orders@autoinx.com';
const STORE_URL           = 'https://autoinx.com';

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

exports.handler = async function () {
    const db          = initAdmin();
    const transporter = getTransporter();

    // Fetch all items
    const snap = await db
        .collection('artifacts/default-app-id/public/data/items')
        .get();

    const lowItems = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(item =>
            !item.temporarilyUnavailable &&
            typeof item.stock === 'number' &&
            item.stock <= LOW_STOCK_THRESHOLD
        )
        .sort((a, b) => a.stock - b.stock);  // most critical first

    if (lowItems.length === 0) {
        console.log('✅ No low-stock items today.');
        return { statusCode: 200, body: JSON.stringify({ alerted: 0 }) };
    }

    // Check which items have already been alerted at this stock level
    const alertsRef    = db.collection('low_stock_alerts');
    const itemsToAlert = [];
    const WEEKLY_REMINDER_MS = 7 * 24 * 60 * 60 * 1000;

    for (const item of lowItems) {
        const prevSnap  = await alertsRef.doc(item.id).get();
        const prevData  = prevSnap.exists ? prevSnap.data() : null;
        const prevStock = prevData ? prevData.lastAlertedStock : null;
        const lastAlert = prevData?.lastAlertedAt?.toDate?.() || null;
        const msSinceAlert = lastAlert ? Date.now() - lastAlert.getTime() : Infinity;

        // Alert if:
        //   • never alerted before
        //   • stock has gone DOWN since last alert (getting worse)
        //   • stock is still low and it's been 7+ days (weekly reminder)
        if (prevStock === null || item.stock < prevStock || msSinceAlert >= WEEKLY_REMINDER_MS) {
            itemsToAlert.push(item);
        }
    }

    if (itemsToAlert.length === 0) {
        console.log('✅ Low-stock items unchanged since last alert — skipping.');
        return { statusCode: 200, body: JSON.stringify({ alerted: 0 }) };
    }

    // Build email
    const outOfStock = itemsToAlert.filter(i => i.stock === 0);
    const critical   = itemsToAlert.filter(i => i.stock > 0 && i.stock <= 3);
    const warning    = itemsToAlert.filter(i => i.stock > 3 && i.stock <= LOW_STOCK_THRESHOLD);

    const renderRows = (items, color, label) => items.map(item => `
        <tr style="border-bottom:1px solid #e5e7eb;">
            <td style="padding:10px 14px;font-size:14px;color:#1e293b;font-weight:600;">
                ${item.name}
                ${item.sku ? `<span style="font-size:11px;color:#94a3b8;font-weight:400;display:block;">SKU: ${item.sku}</span>` : ''}
            </td>
            <td style="padding:10px 14px;text-align:center;">
                <span style="display:inline-block;background:${color}22;color:${color};font-size:13px;font-weight:700;padding:3px 12px;border-radius:20px;border:1px solid ${color}55;">
                    ${item.stock === 0 ? 'OUT' : item.stock} ${item.stock === 0 ? '' : 'left'}
                </span>
            </td>
            <td style="padding:10px 14px;text-align:right;">
                <a href="${STORE_URL}/admin.html"
                   style="font-size:12px;color:#6366f1;text-decoration:none;font-weight:600;">
                    Update stock →
                </a>
            </td>
        </tr>`).join('');

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:40px 0;">
<tr><td align="center">
<table width="620" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:620px;">

  <!-- Header -->
  <tr><td style="background:linear-gradient(135deg,#dc2626,#ef4444);padding:28px 36px;text-align:center;">
    <h1 style="color:#fff;margin:0;font-size:22px;font-weight:700;">⚠️ Low Stock Alert — autoInx</h1>
    <p style="color:rgba(255,255,255,.85);margin:6px 0 0;font-size:14px;">
      ${itemsToAlert.length} item${itemsToAlert.length > 1 ? 's' : ''} need${itemsToAlert.length === 1 ? 's' : ''} restocking · ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
    </p>
  </td></tr>

  <tr><td style="padding:28px 36px;">

    ${outOfStock.length > 0 ? `
    <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;margin-bottom:20px;overflow:hidden;">
      <div style="background:#dc2626;padding:10px 16px;">
        <p style="color:#fff;font-size:13px;font-weight:700;margin:0;text-transform:uppercase;letter-spacing:1px;">
          🚫 Out of Stock (${outOfStock.length})
        </p>
      </div>
      <table width="100%" cellpadding="0" cellspacing="0">
        ${renderRows(outOfStock, '#dc2626', 'OUT OF STOCK')}
      </table>
    </div>` : ''}

    ${critical.length > 0 ? `
    <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;margin-bottom:20px;overflow:hidden;">
      <div style="background:#ea580c;padding:10px 16px;">
        <p style="color:#fff;font-size:13px;font-weight:700;margin:0;text-transform:uppercase;letter-spacing:1px;">
          🔴 Critical — 1–3 units left (${critical.length})
        </p>
      </div>
      <table width="100%" cellpadding="0" cellspacing="0">
        ${renderRows(critical, '#ea580c', 'CRITICAL')}
      </table>
    </div>` : ''}

    ${warning.length > 0 ? `
    <div style="background:#fefce8;border:1px solid #fde68a;border-radius:10px;margin-bottom:20px;overflow:hidden;">
      <div style="background:#d97706;padding:10px 16px;">
        <p style="color:#fff;font-size:13px;font-weight:700;margin:0;text-transform:uppercase;letter-spacing:1px;">
          🟡 Low Stock — 4–${LOW_STOCK_THRESHOLD} units left (${warning.length})
        </p>
      </div>
      <table width="100%" cellpadding="0" cellspacing="0">
        ${renderRows(warning, '#d97706', 'LOW')}
      </table>
    </div>` : ''}

    <div style="text-align:center;margin-top:24px;">
      <a href="${STORE_URL}/admin.html"
         style="display:inline-block;background:linear-gradient(135deg,#6366f1,#4f46e5);color:#fff;padding:12px 32px;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none;">
        📦 Go to Inventory
      </a>
    </div>

  </td></tr>

  <tr><td style="background:#1e293b;padding:18px 36px;text-align:center;">
    <p style="color:#94a3b8;font-size:12px;margin:0;">
      autoInx automated inventory alert · <a href="${STORE_URL}" style="color:#818cf8;">autoinx.com</a>
    </p>
  </td></tr>

</table>
</td></tr></table>
</body></html>`;

    const subject = outOfStock.length > 0
        ? `🚫 ${outOfStock.length} item${outOfStock.length > 1 ? 's' : ''} out of stock — autoInx`
        : `⚠️ Low stock alert: ${itemsToAlert.length} item${itemsToAlert.length > 1 ? 's' : ''} — autoInx`;

    await transporter.sendMail({
        from:    '"autoInx Alerts" <noreply@autoinx.com>',
        to:      ALERT_EMAIL,
        subject, html,
    });

    // Update last-alerted stock levels
    const batch = db.batch();
    for (const item of itemsToAlert) {
        batch.set(alertsRef.doc(item.id), {
            itemId:            item.id,
            itemName:          item.name,
            lastAlertedStock:  item.stock,
            lastAlertedAt:     admin.firestore.FieldValue.serverTimestamp(),
        });
    }
    await batch.commit();

    console.log(`✅ Low-stock alert sent: ${itemsToAlert.length} items (${outOfStock.length} OOS, ${critical.length} critical, ${warning.length} warning)`);
    return { statusCode: 200, body: JSON.stringify({ alerted: itemsToAlert.length, outOfStock: outOfStock.length }) };
};
