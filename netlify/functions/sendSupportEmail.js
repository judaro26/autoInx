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

    await transporter.sendMail({
        from:    `"AutoInx Support Bot" <noreply@autoinx.com>`,
        to:      'support@autoinx.com',
        replyTo: from,
        subject: subject || 'Support inquiry - AutoInx',
        html: `
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
            </div>
        `,
    });

    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ success: true }) };
};
