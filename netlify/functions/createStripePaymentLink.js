const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async function(event) {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    try {
        const {
            orderId,
            buyerEmail,
            buyerName,
            items,
            totalCents,
            subtotalCents,
            shippingCents,
            taxCents,
            language = 'en'
        } = JSON.parse(event.body);

        console.log('Creating Stripe Payment Link for order:', orderId);

        // Create line items for Stripe
        const lineItems = items.map(item => ({
            price_data: {
                currency: 'usd',
                product_data: {
                    name: item.name,
                    metadata: {
                        sku: item.sku || '',
                        order_id: orderId
                    }
                },
                unit_amount: item.price, // Already in cents
            },
            quantity: item.quantity
        }));

        // Add shipping as a line item if it exists
        if (shippingCents > 0) {
            lineItems.push({
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: language === 'es' ? 'Envío' : 'Shipping',
                        description: language === 'es' ? 'Costo de envío' : 'Shipping cost'
                    },
                    unit_amount: shippingCents
                },
                quantity: 1
            });
        }

        // Add tax as a line item if it exists
        if (taxCents > 0) {
            lineItems.push({
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: language === 'es' ? 'Impuesto' : 'Tax',
                        description: language === 'es' ? 'Impuesto sobre ventas' : 'Sales tax'
                    },
                    unit_amount: taxCents
                },
                quantity: 1
            });
        }

        // Create Stripe Payment Link
        const paymentLink = await stripe.paymentLinks.create({
            line_items: lineItems,
            metadata: {
                order_id: orderId,
                buyer_email: buyerEmail,
                buyer_name: buyerName,
                integration: 'autoinx_checkout'
            },
            after_completion: {
                type: 'redirect',
                redirect: {
                    url: `${process.env.URL || 'https://autoinx.com'}/payment-success?order=${orderId}`
                }
            },
            // Pre-fill customer email
            customer_creation: 'always',
            phone_number_collection: {
                enabled: false // We already have their phone
            },
            // Allow promocodes if you want
            allow_promotion_codes: true,
            // Set custom text
            custom_text: {
                submit: {
                    message: language === 'es' 
                        ? `Pedido #${orderId.substring(0, 8)}` 
                        : `Order #${orderId.substring(0, 8)}`
                }
            }
        });

        console.log('✅ Payment link created:', paymentLink.url);

        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                paymentUrl: paymentLink.url,
                paymentLinkId: paymentLink.id,
                orderId
            })
        };

    } catch (error) {
        console.error('❌ Stripe Payment Link Error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: 'Failed to create payment link',
                details: error.message
            })
        };
    }
};
