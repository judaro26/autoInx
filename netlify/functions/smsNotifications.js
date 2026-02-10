const Telnyx = require('telnyx');

// Initialize with your API Key
const telnyx = Telnyx(process.env.TELNYX_API_KEY);

// Your Telnyx Phone Number (Must be WhatsApp enabled in portal for WA to work)
const SENDER_NUMBER = process.env.TELNYX_PHONE_NUMBER; 

// ─── Message templates (Kept exactly the same) ────────────────────────────────
function buildMessage(order, lang) {
    const name     = order.buyerName?.split(' ')[0] || 'Cliente';
    const orderId  = order.id?.slice(-6).toUpperCase() || '------';
    const total    = order.totalCents ? `$${(order.totalCents / 100).toFixed(2)}` : '';
    const status   = order.status || 'Processing';
    const tracking = order.trackingNumber || null;

    const templates = {
        es: {
            confirmed: `✅ *AutoInx* - Hola ${name}! Tu pedido #${orderId} fue confirmado por ${total}. Te avisaremos cuando sea enviado. ¿Preguntas? Escríbenos aquí.`,
            processing: `📦 *AutoInx* - Hola ${name}! Tu pedido #${orderId} está siendo preparado. Te notificaremos cuando salga.`,
            shipped: tracking
                ? `🚚 *AutoInx* - Hola ${name}! Tu pedido #${orderId} fue enviado. Rastréalo con: ${tracking}`
                : `🚚 *AutoInx* - Hola ${name}! Tu pedido #${orderId} fue enviado y está en camino.`,
            delivered: `🎉 *AutoInx* - Hola ${name}! Tu pedido #${orderId} fue entregado. ¡Gracias por tu compra!`,
            cancelled: `❌ *AutoInx* - Hola ${name}. Tu pedido #${orderId} fue cancelado. Contáctanos si tienes dudas.`,
        },
        en: {
            confirmed: `✅ *AutoInx* - Hi ${name}! Your order #${orderId} has been confirmed for ${total}. We'll notify you when it ships. Questions? Reply here.`,
            processing: `📦 *AutoInx* - Hi ${name}! Your order #${orderId} is being prepared. We'll notify you when it's on its way.`,
            shipped: tracking
                ? `🚚 *AutoInx* - Hi ${name}! Your order #${orderId} has shipped. Track it: ${tracking}`
                : `🚚 *AutoInx* - Hi ${name}! Your order #${orderId} has shipped and is on its way.`,
            delivered: `🎉 *AutoInx* - Hi ${name}! Your order #${orderId} was delivered. Thank you for your purchase!`,
            cancelled: `❌ *AutoInx* - Hi ${name}. Your order #${orderId} was cancelled. Contact us if you have questions.`,
        }
    };

    const lang_templates = templates[lang] || templates['es'];
    const statusKey = status.toLowerCase();
    return lang_templates[statusKey] || lang_templates['confirmed'];
}

// ─── Send via WhatsApp (Telnyx) ───────────────────────────────────────────────
async function sendWhatsApp(toPhone, message) {
    const normalized = toPhone.replace(/\D/g, '');
    
    // Telnyx handles WhatsApp via the same messages API if configured, 
    // but you must specify the type or profile. 
    // *Important*: Ensure your Telnyx Messaging Profile has WhatsApp enabled.
    
    return telnyx.messages.create({
        from: SENDER_NUMBER, // Must be your WhatsApp-enabled Telnyx number
        to: `+${normalized}`,
        text: message,
        type: 'whatsapp' // Explicitly set type to WhatsApp
    });
}

// ─── Send via SMS (Telnyx) ────────────────────────────────────────────────────
async function sendSMS(toPhone, message) {
    const normalized = toPhone.replace(/\D/g, '');
    // Strip bold markdown for SMS
    const plainText = message.replace(/\*/g, '');

    return telnyx.messages.create({
        from: SENDER_NUMBER,
        to: `+${normalized}`,
        text: plainText,
        type: 'sms' // Explicitly set type to SMS
    });
}

// ─── Handler ──────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    try {
        const { order } = JSON.parse(event.body);

        if (!order) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing order data' }) };
        }

        const phone          = order.buyerPhone;
        const wantsWhatsApp  = order.whatsappConsent === true;
        const wantsSMS       = order.smsConsent === true;
        const lang           = order.language || 'es';

        if (!phone || (!wantsWhatsApp && !wantsSMS)) {
            return {
                statusCode: 200,
                body: JSON.stringify({ success: true, skipped: true, reason: 'No phone or no notification consent' })
            };
        }

        const message = buildMessage(order, lang);
        const results = [];

        // WhatsApp Priority Logic
        if (wantsWhatsApp) {
            try {
                const msg = await sendWhatsApp(phone, message);
                // Telnyx returns an ID in msg.data.id or msg.id depending on response structure
                const sid = msg.data ? msg.data.id : msg.id; 
                
                results.push({ channel: 'whatsapp', sid: sid, status: 'queued' });
                console.log(`✅ WhatsApp sent to ${phone} | ID: ${sid}`);
            } catch (err) {
                console.error(`❌ WhatsApp failed for ${phone}:`, err.message); // err.raw can give more info
                
                // Fallback to SMS
                if (wantsSMS) {
                    try {
                        const msg = await sendSMS(phone, message);
                        const sid = msg.data ? msg.data.id : msg.id;
                        results.push({ channel: 'sms_fallback', sid: sid, status: 'queued' });
                        console.log(`✅ SMS fallback sent to ${phone} | ID: ${sid}`);
                    } catch (smsErr) {
                         console.error(`❌ SMS Fallback failed for ${phone}:`, smsErr.message);
                    }
                }
            }
        } else if (wantsSMS) {
            try {
                const msg = await sendSMS(phone, message);
                const sid = msg.data ? msg.data.id : msg.id;
                results.push({ channel: 'sms', sid: sid, status: 'queued' });
                console.log(`✅ SMS sent to ${phone} | ID: ${sid}`);
            } catch (err) {
                 console.error(`❌ SMS failed for ${phone}:`, err.message);
            }
        }

        return {
            statusCode: 200,
            body: JSON.stringify({ success: true, results })
        };

    } catch (error) {
        console.error('sendOrderNotification error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to send notification', details: error.message })
        };
    }
};
