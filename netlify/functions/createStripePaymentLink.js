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

        // Build line items with tax_behavior: 'exclusive' so Stripe Tax adds
        // the correct amount on top — consistent with what buyer saw at checkout.
        const lineItems = items.map(item => ({
            price_data: {
                currency: 'usd',
                product_data: {
                    name: item.name,
                    metadata: { sku: item.sku || '', order_id: orderId },
                    tax_code: 'txcd_99999999',  // General tangible goods (auto parts)
                },
                unit_amount: item.price,        // Already in cents
                tax_behavior: 'exclusive',      // Tax added on top, not included
            },
            quantity: item.quantity
        }));

        // Shipping as a separate line item with its own tax code
        if (shippingCents > 0) {
            lineItems.push({
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: language === 'es' ? 'Envío' : 'Shipping',
                        description: language === 'es' ? 'Costo de envío' : 'Shipping cost',
                        tax_code: 'txcd_92010001',  // Shipping / delivery tax code
                    },
                    unit_amount: shippingCents,
                    tax_behavior: 'exclusive',
                },
                quantity: 1
            });
        }

        // ✅ NOTE: Tax is NOT added as a line item anymore.
        // automatic_tax: { enabled: true } makes Stripe the authoritative
        // tax calculator — it collects buyer's address on the payment page,
        // applies the correct jurisdiction rates, and generates remittance reports.

        // Create Stripe Payment Link
        const paymentLink = await stripe.paymentLinks.create({
            line_items: lineItems,

            // ✅ KEY: automatic_tax makes Stripe the authoritative tax collector.
            // Stripe collects the buyer's billing address on the payment page,
            // applies the correct rates, and includes tax in settlement + reports.
            automatic_tax: { enabled: true },

            // Collect billing address for tax jurisdiction accuracy
            billing_address_collection: 'required',

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
