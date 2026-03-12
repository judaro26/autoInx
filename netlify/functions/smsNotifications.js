const Telnyx = require('telnyx');

const API_KEY = process.env.TELNYX_API_KEY;
const SENDER_NUMBER = process.env.TELNYX_PHONE_NUMBER;

// Initialize Telnyx
const telnyx = Telnyx(API_KEY);

function buildMessage(order, lang) {
    // ... (Keep your existing buildMessage function) ...
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
    // Default to 'confirmed' if status not found
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

        // 1. Build Message
        // SMS doesn't support bolding (*), so we strip it out
        const rawMessage = buildMessage(order, order.language || 'es');
        const smsMessage = rawMessage.replace(/\*/g, ''); 

        // 2. Send SMS (The part we know works!)
        try {
            const normalized = order.buyerPhone.replace(/\D/g, '');
            const msg = await telnyx.messages.create({
                from: SENDER_NUMBER,
                to: `+${normalized}`,
                text: smsMessage,
                type: 'sms'
            });

            console.log(`✅ SMS sent to ${order.buyerPhone} | ID: ${msg.data.id}`);
            
            return {
                statusCode: 200,
                body: JSON.stringify({ success: true, sid: msg.data.id })
            };

        } catch (err) {
            console.error('❌ SMS Failed:', JSON.stringify(err, null, 2));
            return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
        }

    } catch (error) {
        console.error('Handler Error:', error);
        return { statusCode: 500, body: error.toString() };
    }
};
