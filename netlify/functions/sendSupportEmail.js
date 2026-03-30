/**
 * Netlify Function: sendSupportEmail.js
 * Receives chat escalation submissions and forwards them to support@autoinx.com
 */
const nodemailer = require('nodemailer');

const HEADERS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': process.env.URL || 'https://autoinx.com',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };
    if (event.httpMethod !== 'POST') return { statusCode: 405, headers: HEADERS, body: '{}' };

    // Rate limiting — 5 per IP per 15 min
    const ip = event.headers['x-forwarded-for']?.split(',')[0].trim() || 'unknown';
    const now = Date.now();
    if (!global._supportRL) global._supportRL = {};
    const entry = global._supportRL[ip] || { count: 0, reset: now + 15 * 60000 };
    if (now > entry.reset) { entry.count = 0; entry.reset = now + 15 * 60000; }
    entry.count++;
    global._supportRL[ip] = entry;
    if (entry.count > 5) return { statusCode: 429, headers: HEADERS, body: JSON.stringify({ error: 'Too many requests' }) };

    let body;
    try { body = JSON.parse(event.body); } catch { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

    const { from, subject, message, chatHistory } = body;
    if (!from || !message) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'from and message are required' }) };

    const transporter = nodemailer.createTransport({
        host:   process.env.BREVO_SMTP_HOST || 'smtp-relay.brevo.com',
        port:   parseInt(process.env.BREVO_SMTP_PORT || '587'),
        secure: false,
        auth:   { user: process.env.BREVO_SMTP_USER, pass: process.env.BREVO_SMTP_PASSWORD },
    });

    const adminHtml = `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
            <h2 style="color:#4f46e5;">New Support Inquiry from AutoInx Chat</h2>
            <p><strong>From:</strong> ${from}</p>
            <hr>
            <h3>Customer Message:</h3>
            <p style="background:#f3f4f6;padding:12px;border-radius:8px;">${message.replace(/\n/g,'<br>')}</p>
            ${chatHistory && chatHistory !== '—' ? `
            <h3>Prior Chat History:</h3>
            <pre style="background:#f9fafb;padding:12px;border-radius:8px;font-size:12px;overflow-x:auto;">${chatHistory}</pre>` : ''}
            <hr>
            <p style="color:#9ca3af;font-size:12px;">Sent via AutoInx chat escalation widget</p>
        </div>`;

    const customerHtml = `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
            <div style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:24px;border-radius:12px 12px 0 0;text-align:center;">
                <h1 style="color:white;margin:0;font-size:1.4rem;">✅ We received your message</h1>
                <p style="color:#c7d2fe;margin:8px 0 0;font-size:.9rem;">Recibimos tu consulta / We got your inquiry</p>
            </div>
            <div style="background:#f9fafb;border:1px solid #e5e7eb;border-top:none;padding:24px;border-radius:0 0 12px 12px;">
                <p style="color:#374151;">Hi there,</p>
                <p style="color:#374151;">Thank you for reaching out to AutoInx. We received your message and will get back to you within <strong>24 business hours</strong>.</p>
                <div style="background:white;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:16px 0;">
                    <p style="color:#6b7280;font-size:.8rem;margin:0 0 8px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;">Your message</p>
                    <p style="color:#374151;margin:0;">${message.replace(/\n/g,'<br>')}</p>
                </div>
                <p style="color:#374151;">For urgent matters, you can also email us directly at <a href="mailto:support@autoinx.com" style="color:#4f46e5;">support@autoinx.com</a>.</p>
                <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;">
                <p style="color:#9ca3af;font-size:.8rem;margin:0;">© AutoInx · Family-Owned · Hayward, CA</p>
            </div>
        </div>`;

    // Send to admin
    await transporter.sendMail({
        from:    '"AutoInx Support Bot" <noreply@autoinx.com>',
        to:      'support@autoinx.com',
        replyTo: from,
        subject: subject || 'Support inquiry - AutoInx',
        html:    adminHtml,
    });

    // Send confirmation copy to customer
    await transporter.sendMail({
        from:    '"AutoInx" <noreply@autoinx.com>',
        to:      from,
        replyTo: 'support@autoinx.com',
        subject: 'We received your message — AutoInx',
        html:    customerHtml,
    });

    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
};
