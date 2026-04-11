const axios = require('axios');
const admin = require('firebase-admin');

const ACCOUNT_SID      = process.env.TEXTGRID_ACCOUNT_SID;
const AUTH_TOKEN       = process.env.TEXTGRID_AUTH_TOKEN;
const SENDER_NUMBER_ENV = process.env.TEXTGRID_PHONE_NUMBER;

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

// Reads sender phone from Firestore admin config; falls back to env var
async function getSenderPhone() {
    try {
        const db  = initAdmin();
        const doc = await db.collection('admin').doc('config').get();
        const stored = doc.data()?.sms?.senderPhone;
        return stored || SENDER_NUMBER_ENV;
    } catch {
        return SENDER_NUMBER_ENV;
    }
}

function buildMessage(order, lang) {
    const name     = order.buyerName?.split(' ')[0] || 'Cliente';
    const orderId  = order.id?.slice(-6).toUpperCase() || '------';
    const status   = order.status || 'Processing';
    const tracking = order.trackingNumber || null;

    const templates = {
        es: {
            confirmed: `✅ AutoInx: Hola ${name}! Pedido #${orderId} confirmado. Te avisaremos cuando sea enviado.`,
            shipped: tracking
                ? `🚚 AutoInx: Hola ${name}! Pedido #${orderId} enviado. Tracking: ${tracking}`
                : `🚚 AutoInx: Hola ${name}! Pedido #${orderId} enviado.`,
            delivered: `🎉 AutoInx: Pedido #${orderId} entregado. Gracias!`,
            cancelled: `❌ AutoInx: Pedido #${orderId} cancelado.`,
        },
        en: {
            confirmed: `✅ AutoInx: Hi ${name}! Order #${orderId} confirmed. We'll notify you when it ships.`,
            shipped: tracking
                ? `🚚 AutoInx: Hi ${name}! Order #${orderId} shipped. Track: ${tracking}`
                : `🚚 AutoInx: Hi ${name}! Order #${orderId} shipped.`,
            delivered: `🎉 AutoInx: Order #${orderId} delivered. Thanks!`,
            cancelled: `❌ AutoInx: Order #${orderId} cancelled.`,
        }
    };

    const lang_templates = templates[lang] || templates['es'];
    const statusKey = status.toLowerCase();
    return lang_templates[statusKey] || lang_templates['confirmed'];
}

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const { order } = JSON.parse(event.body);
        if (!order || !order.buyerPhone) {
            return { statusCode: 200, body: JSON.stringify({ skipped: true }) };
        }

        // Build message (strip asterisks — SMS doesn't support bold)
        const rawMessage = buildMessage(order, order.language || 'es');
        const smsMessage = rawMessage.replace(/\*/g, '');

        // Send via TextGrid (Twilio-compatible REST API)
        try {
            const normalized  = order.buyerPhone.replace(/\D/g, '');
            const senderPhone = await getSenderPhone();

            const params = new URLSearchParams();
            params.append('From', senderPhone);
            params.append('To', `+${normalized}`);
            params.append('Body', smsMessage);

            const response = await axios.post(
                `https://api.textgrid.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`,
                params,
                {
                    auth: {
                        username: ACCOUNT_SID,
                        password: AUTH_TOKEN
                    },
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                }
            );

            const sid = response.data?.sid;
            console.log(`✅ SMS sent to ${order.buyerPhone} | SID: ${sid}`);

            return {
                statusCode: 200,
                body: JSON.stringify({ success: true, sid })
            };

        } catch (err) {
            const detail = err.response?.data || err.message;
            console.error('❌ SMS Failed:', JSON.stringify(detail, null, 2));
            return { statusCode: 500, body: JSON.stringify({ error: detail }) };
        }

    } catch (error) {
        console.error('Handler Error:', error);
        return { statusCode: 500, body: error.toString() };
    }
};
