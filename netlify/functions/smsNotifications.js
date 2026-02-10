const Telnyx = require('telnyx');

// ─── CONFIGURATION CHECK ──────────────────────────────────────────────────────
const API_KEY = process.env.TELNYX_API_KEY;
const SENDER_NUMBER = process.env.TELNYX_PHONE_NUMBER;

if (!API_KEY) {
    console.error("🚨 CRITICAL ERROR: TELNYX_API_KEY is missing from Netlify environment variables.");
}
if (!SENDER_NUMBER) {
    console.error("🚨 CRITICAL ERROR: TELNYX_PHONE_NUMBER is missing from Netlify environment variables.");
}

// Initialize Telnyx
const telnyx = Telnyx(API_KEY);

// ─── HELPER: SAFE ERROR LOGGER ────────────────────────────────────────────────
// This fixes the "undefined" error in your logs by handling different error types
function logError(context, err) {
    const errorDetails = err.raw || err.response || err.message || err;
    console.error(`❌ ${context} Failed:`, JSON.stringify(errorDetails, null, 2));
}

// ─── MESSAGE TEMPLATES ────────────────────────────────────────────────────────
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

// ─── SEND VIA WHATSAPP (TELNYX) ───────────────────────────────────────────────
async function sendWhatsApp(toPhone, message) {
    const normalized = toPhone.replace(/\D/g, '');
    
    return telnyx.messages.create({
        from: SENDER_NUMBER,
        to: `+${normalized}`,
        text: message, // Telnyx uses 'text', Twilio uses 'body'
        type: 'whatsapp'
    });
}

// ─── SEND VIA SMS (TELNYX) ────────────────────────────────────────────────────
async function sendSMS(toPhone, message) {
    const normalized = toPhone.replace(/\D/g, '');
    const plainText = message.replace(/\*/g, ''); // Strip Markdown

    return telnyx.messages.create({
        from: SENDER_NUMBER,
        to: `+${normalized}`,
        text: plainText, // Telnyx uses 'text', Twilio uses 'body'
        type: 'sms'
    });
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
exports.handler = async (event) => {
    // 1. Method Check
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    try {
        // 2. Parse Body
        const { order } = JSON.parse(event.body);
        if (!order) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing order data' }) };
        }

        const phone          = order.buyerPhone;
        const wantsWhatsApp  = order.whatsappConsent === true;
        const wantsSMS       = order.smsConsent === true;
        const lang           = order.language || 'es';

        // 3. Early Exit
        if (!phone || (!wantsWhatsApp && !wantsSMS)) {
            return {
                statusCode: 200,
                body: JSON.stringify({ success: true, skipped: true, reason: 'No phone or no notification consent' })
            };
        }

        // 4. Send Logic
        const message = buildMessage(order, lang);
        const results = [];

        // WhatsApp Priority
        if (wantsWhatsApp) {
            try {
                const msg = await sendWhatsApp(phone, message);
                const sid = msg.data ? msg.data.id : msg.id;
                results.push({ channel: 'whatsapp', sid: sid, status: 'queued' });
                console.log(`✅ WhatsApp sent to ${phone} | ID: ${sid}`);
            } catch (err) {
                logError("WhatsApp", err);
                
                // Fallback to SMS if WhatsApp fails
                if (wantsSMS) {
                    try {
                        console.log(`⚠️ Attempting SMS Fallback for ${phone}...`);
                        const msg = await sendSMS(phone, message);
                        const sid = msg.data ? msg.data.id : msg.id;
                        results.push({ channel: 'sms_fallback', sid: sid, status: 'queued' });
                        console.log(`✅ SMS fallback sent to ${phone} | ID: ${sid}`);
                    } catch (smsErr) {
                         logError("SMS Fallback", smsErr);
                    }
                }
            }
        } 
        // SMS Only
        else if (wantsSMS) {
            try {
                const msg = await sendSMS(phone, message);
                const sid = msg.data ? msg.data.id : msg.id;
                results.push({ channel: 'sms', sid: sid, status: 'queued' });
                console.log(`✅ SMS sent to ${phone} | ID: ${sid}`);
            } catch (err) {
                 logError("SMS", err);
            }
        }

        return {
            statusCode: 200,
            body: JSON.stringify({ success: true, results })
        };

    } catch (error) {
        console.error('🚨 Global Handler Error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to send notification', details: error.toString() })
        };
    }
};
