const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');

function getDb() {
    if (admin.apps.length === 0) {
        const serviceAccount = {
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        };
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: process.env.FIREBASE_DATABASE_URL
        });
    }
    return admin.firestore();
}

exports.handler = async function(event) {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const sig = event.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let stripeEvent;

    try {
        // Verify webhook signature
        stripeEvent = stripe.webhooks.constructEvent(
            event.body,
            sig,
            webhookSecret
        );
    } catch (err) {
        console.error('❌ Webhook signature verification failed:', err.message);
        return { statusCode: 400, body: `Webhook Error: ${err.message}` };
    }

    console.log('✅ Stripe webhook received:', stripeEvent.type);

    // Handle the event
    try {
        switch (stripeEvent.type) {
            case 'checkout.session.completed':
                await handleCheckoutComplete(stripeEvent.data.object);
                break;
            
            case 'payment_link.paid':
                await handlePaymentLinkPaid(stripeEvent.data.object);
                break;
            
            case 'charge.succeeded':
                await handleChargeSucceeded(stripeEvent.data.object);
                break;

            case 'payment_intent.succeeded':
                await handlePaymentSuccess(stripeEvent.data.object);
                break;

            default:
                console.log(`ℹ️  Unhandled event type: ${stripeEvent.type}`);
        }

        return {
            statusCode: 200,
            body: JSON.stringify({ received: true })
        };

    } catch (error) {
        console.error('❌ Webhook processing error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};

async function handleCheckoutComplete(session) {
    console.log('💳 Checkout session completed:', session.id);
    const orderId = session.metadata?.order_id;
    
    if (!orderId) {
        console.warn('⚠️  No order_id in session metadata');
        return;
    }

    await updateOrderStatus(orderId, 'Processing', {
        stripeSessionId: session.id,
        stripePaymentStatus: session.payment_status,
        amountTotal: session.amount_total,
        paidAt: new Date().toISOString()
    });
}

async function handlePaymentLinkPaid(paymentLink) {
    console.log('🔗 Payment link paid:', paymentLink.id);
    // Payment link doesn't have order_id directly, need to get it from metadata
    // This will be triggered when customer completes payment
}

async function handleChargeSucceeded(charge) {
    console.log('💰 Charge succeeded:', charge.id);
    const orderId = charge.metadata?.order_id;
    
    if (!orderId) {
        console.warn('⚠️  No order_id in charge metadata');
        return;
    }

    await updateOrderStatus(orderId, 'Processing', {
        stripeChargeId: charge.id,
        stripePaymentMethod: charge.payment_method_details?.type,
        amountReceived: charge.amount_received,
        paidAt: new Date().toISOString()
    });
}

async function handlePaymentSuccess(paymentIntent) {
    console.log('✅ Payment intent succeeded:', paymentIntent.id);
    const orderId = paymentIntent.metadata?.order_id;
    
    if (!orderId) {
        console.warn('⚠️  No order_id in payment intent metadata');
        return;
    }

    await updateOrderStatus(orderId, 'Processing', {
        stripePaymentIntentId: paymentIntent.id,
        amountReceived: paymentIntent.amount_received,
        paidAt: new Date().toISOString()
    });
}

async function updateOrderStatus(orderId, newStatus, paymentData) {
    try {
        const db = getDb();
        const orderRef = db.doc(`artifacts/default-app-id/public/data/orders/${orderId}`);
        
        const updateData = {
            status: newStatus,
            paymentStatus: 'Paid',
            paymentData: paymentData,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        await orderRef.update(updateData);
        console.log(`✅ Order ${orderId} updated to ${newStatus} (Paid)`);

        // Optionally send a "Payment Received" email here
        // await sendPaymentConfirmationEmail(orderId);

    } catch (error) {
        console.error(`❌ Failed to update order ${orderId}:`, error);
        throw error;
    }
}
