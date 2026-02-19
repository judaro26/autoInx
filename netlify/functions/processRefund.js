const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event) => {
    // CORS headers
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Content-Type': 'application/json'
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    try {
        const {
            paymentIntentId,   // Stripe Payment Intent ID (pi_xxx)
            chargeId,          // OR Stripe Charge ID (ch_xxx) — either works
            amountCents,       // Amount to refund in cents (null = full refund)
            reason,            // 'duplicate' | 'fraudulent' | 'requested_by_customer' (Stripe enum)
            orderId,           // For logging
            adminEmail         // For audit trail
        } = JSON.parse(event.body);

        if (!paymentIntentId && !chargeId) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'Either paymentIntentId or chargeId is required.' })
            };
        }

        // Build refund parameters
        const refundParams = {};

        if (paymentIntentId) {
            refundParams.payment_intent = paymentIntentId;
        } else if (chargeId) {
            refundParams.charge = chargeId;
        }

        // Partial refund: specify amount; Full refund: omit amount
        if (amountCents && amountCents > 0) {
            refundParams.amount = amountCents;
        }

        // Stripe-accepted reason values
        if (reason && ['duplicate', 'fraudulent', 'requested_by_customer'].includes(reason)) {
            refundParams.reason = reason;
        }

        // Add metadata for audit
        refundParams.metadata = {
            orderId: orderId || 'unknown',
            adminEmail: adminEmail || 'unknown',
            refundedAt: new Date().toISOString()
        };

        console.log('Processing refund:', refundParams);

        const refund = await stripe.refunds.create(refundParams);

        console.log('Refund created:', refund.id, refund.status);

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                refundId: refund.id,
                status: refund.status,          // 'succeeded' | 'pending' | 'failed'
                amountRefunded: refund.amount,   // In cents
                currency: refund.currency,
                created: refund.created
            })
        };

    } catch (error) {
        console.error('Stripe refund error:', error);

        return {
            statusCode: error.statusCode || 500,
            headers,
            body: JSON.stringify({
                success: false,
                error: error.message,
                type: error.type,
                code: error.code
            })
        };
    }
};
