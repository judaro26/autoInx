const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');

function getDb() {
    if (admin.apps.length === 0) {
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId:   process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            }),
            databaseURL: process.env.FIREBASE_DATABASE_URL
        });
    }
    return admin.firestore();
}

exports.handler = async function(event) {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const sig           = event.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    let stripeEvent;

    try {
        stripeEvent = stripe.webhooks.constructEvent(event.body, sig, webhookSecret);
    } catch (err) {
        console.error('❌ Webhook signature verification failed:', err.message);
        return { statusCode: 400, body: `Webhook Error: ${err.message}` };
    }

    console.log('✅ Stripe webhook received:', stripeEvent.type);

    try {
        switch (stripeEvent.type) {
            case 'checkout.session.completed':
                await handleCheckoutComplete(stripeEvent.data.object);
                break;
            case 'payment_intent.succeeded':
                await handlePaymentSuccess(stripeEvent.data.object);
                break;
            case 'charge.succeeded':
                await handleChargeSucceeded(stripeEvent.data.object);
                break;
            default:
                console.log(`ℹ️  Unhandled event type: ${stripeEvent.type}`);
        }
        return { statusCode: 200, body: JSON.stringify({ received: true }) };

    } catch (error) {
        console.error('❌ Webhook processing error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};

// ── Primary handler: checkout.session.completed ──────────────────────────────
// Fired for both Stripe Checkout Sessions AND Payment Links.
async function handleCheckoutComplete(session) {
    console.log('💳 Checkout session completed:', session.id);

    const orderId = session.metadata?.order_id;
    const userId  = session.metadata?.user_id || null;

    if (!orderId) {
        console.warn('⚠️  No order_id in session metadata — cannot update order');
        return;
    }

    // Retrieve full session to get authoritative tax/shipping amounts
    const fullSession = await stripe.checkout.sessions.retrieve(session.id, {
        expand: ['total_details']
    });

    const taxCentsActual      = fullSession.total_details?.amount_tax      || 0;
    const shippingCentsActual = fullSession.total_details?.amount_shipping  || 0;
    const totalCentsActual    = fullSession.amount_total                    || 0;
    const subtotalCentsActual = fullSession.amount_subtotal                 || 0;

    console.log(`💰 Order ${orderId} — collected: subtotal=$${(subtotalCentsActual/100).toFixed(2)} tax=$${(taxCentsActual/100).toFixed(2)} shipping=$${(shippingCentsActual/100).toFixed(2)} total=$${(totalCentsActual/100).toFixed(2)}`);

    await updateOrderPaymentStatus(orderId, {
        stripeSessionId:      session.id,
        stripePaymentStatus:  session.payment_status,
        stripeCustomerId:     session.customer || null,
        stripeCustomerEmail:  session.customer_details?.email || null,
        taxCentsActual,
        shippingCentsActual,
        totalCentsActual,
        subtotalCentsActual,
        paidAt: new Date().toISOString(),
    });

    // Clear the abandoned cart so scheduled reminder emails stop
    if (userId) await clearAbandonedCart(userId);
}

// ── Fallback handlers ─────────────────────────────────────────────────────────
async function handlePaymentSuccess(paymentIntent) {
    const orderId = paymentIntent.metadata?.order_id;
    const userId  = paymentIntent.metadata?.user_id || null;
    if (!orderId) { console.warn('⚠️  No order_id in payment_intent metadata'); return; }

    await updateOrderPaymentStatus(orderId, {
        stripePaymentIntentId: paymentIntent.id,
        amountReceived: paymentIntent.amount_received,
        paidAt: new Date().toISOString(),
    });

    if (userId) await clearAbandonedCart(userId);
}

async function handleChargeSucceeded(charge) {
    const orderId = charge.metadata?.order_id;
    const userId  = charge.metadata?.user_id || null;
    if (!orderId) { console.warn('⚠️  No order_id in charge metadata'); return; }

    await updateOrderPaymentStatus(orderId, {
        stripeChargeId:      charge.id,
        stripePaymentMethod: charge.payment_method_details?.type,
        amountReceived:      charge.amount_received,
        paidAt:              new Date().toISOString(),
    });

    if (userId) await clearAbandonedCart(userId);
}

// ── Firestore helpers ─────────────────────────────────────────────────────────
async function updateOrderPaymentStatus(orderId, paymentData) {
    try {
        const db       = getDb();
        const orderRef = db.doc(`artifacts/default-app-id/public/data/orders/${orderId}`);

        await orderRef.update({
            status:        'Processing',
            paymentStatus: 'Paid',
            paymentData,
            // Top-level copies for easy admin dashboard queries
            ...(paymentData.taxCentsActual   !== undefined && { taxCentsActual:   paymentData.taxCentsActual }),
            ...(paymentData.totalCentsActual !== undefined && { totalCentsActual: paymentData.totalCentsActual }),
            ...(paymentData.paidAt           !== undefined && { paidAt:           paymentData.paidAt }),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        console.log(`✅ Order ${orderId} → Processing / Paid`);
    } catch (err) {
        console.error(`❌ Failed to update order ${orderId}:`, err);
        throw err;
    }
}

async function clearAbandonedCart(userId) {
    try {
        const db      = getDb();
        const cartRef = db.doc(`abandoned_carts/${userId}`);
        await cartRef.delete();
        console.log(`🛒 Abandoned cart cleared for user: ${userId}`);
    } catch (err) {
        // Non-fatal — cart may have already been cleared client-side
        console.warn(`⚠️  Could not clear abandoned cart for ${userId}:`, err.message);
    }
}
