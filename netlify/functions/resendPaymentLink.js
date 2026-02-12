const admin = require('firebase-admin');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const nodemailer = require('nodemailer');

// Initialize Firebase Admin (only once)
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
        })
    });
}

const db = admin.firestore();

exports.handler = async (event, context) => {
    // Only allow POST
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            body: JSON.stringify({ error: 'Method not allowed' })
        };
    }

    try {
        // ✅ FIX: Extract and verify admin token
        const authHeader = event.headers.authorization || event.headers.Authorization;
        
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            console.error('❌ No authorization header found');
            return {
                statusCode: 401,
                body: JSON.stringify({ error: 'No authorization token provided' })
            };
        }

        const token = authHeader.replace('Bearer ', '');
        
        // ✅ Verify the token and check admin claim
        let decodedToken;
        try {
            decodedToken = await admin.auth().verifyIdToken(token);
            console.log('✅ Token verified for user:', decodedToken.uid);
        } catch (verifyError) {
            console.error('❌ Token verification failed:', verifyError.message);
            return {
                statusCode: 401,
                body: JSON.stringify({ 
                    error: 'Invalid token',
                    details: verifyError.message 
                })
            };
        }

        // ✅ Check if user is admin
        if (!decodedToken.admin) {
            console.error('❌ User is not an admin:', decodedToken.uid);
            return {
                statusCode: 403,
                body: JSON.stringify({ error: 'Admin access required' })
            };
        }

        console.log('✅ Admin verified:', decodedToken.email);

        // Parse request body
        const { orderId, sendEmail = true } = JSON.parse(event.body);

        if (!orderId) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'orderId is required' })
            };
        }

        console.log('📦 Processing payment link for order:', orderId);

        // Get order from Firestore
        const appId = process.env.APP_ID || 'default-app-id';
        const orderRef = db.doc(`artifacts/${appId}/public/data/orders/${orderId}`);
        const orderSnap = await orderRef.get();

        if (!orderSnap.exists) {
            return {
                statusCode: 404,
                body: JSON.stringify({ error: 'Order not found' })
            };
        }

        const order = orderSnap.data();
        console.log('✅ Order found:', order.buyerEmail);

        // Check if payment link already exists and is still valid
        let paymentUrl = order.stripePaymentUrl;
        let paymentLinkId = order.stripePaymentLinkId;

        if (!paymentUrl || !paymentLinkId) {
            console.log('💳 Creating new Stripe Payment Link...');

            // Create line items
            const lineItems = order.items.map(item => {
                const itemData = item.item ? item.item : item;
                return {
                    price_data: {
                        currency: 'usd',
                        product_data: {
                            name: itemData.name,
                            description: itemData.sku ? `SKU: ${itemData.sku}` : undefined
                        },
                        unit_amount: itemData.price
                    },
                    quantity: item.quantity
                };
            });

            // Add shipping if exists
            if (order.shippingCents > 0) {
                lineItems.push({
                    price_data: {
                        currency: 'usd',
                        product_data: { name: '📦 Shipping' },
                        unit_amount: order.shippingCents
                    },
                    quantity: 1
                });
            }

            // Add tax if exists
            if (order.taxCents > 0) {
                lineItems.push({
                    price_data: {
                        currency: 'usd',
                        product_data: { name: '📋 Tax' },
                        unit_amount: order.taxCents
                    },
                    quantity: 1
                });
            }

            // Create Payment Link
            const paymentLink = await stripe.paymentLinks.create({
                line_items: lineItems,
                after_completion: {
                    type: 'redirect',
                    redirect: {
                        url: `${process.env.URL}/payment-success.html?order=${orderId}`
                    }
                },
                metadata: {
                    order_id: orderId,
                    buyer_email: order.buyerEmail,
                    buyer_name: order.buyerName
                },
                custom_text: {
                    submit: { message: `Order #${orderId.substring(0, 8)}` }
                },
                invoice_creation: {
                    enabled: true,
                    invoice_data: {
                        description: `AutoInx Order #${orderId.substring(0, 8)}`,
                        metadata: { order_id: orderId },
                        custom_fields: [
                            { name: 'Order ID', value: orderId.substring(0, 8) }
                        ]
                    }
                }
            });

            paymentUrl = paymentLink.url;
            paymentLinkId = paymentLink.id;

            // Save to order
            await orderRef.update({
                stripePaymentUrl: paymentUrl,
                stripePaymentLinkId: paymentLinkId,
                paymentLinkCreatedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            console.log('✅ Payment link created:', paymentLinkId);
        } else {
            console.log('✅ Using existing payment link:', paymentLinkId);
        }

        // Send email if requested
        if (sendEmail) {
            console.log('📧 Sending payment link email...');

            const transporter = nodemailer.createTransport({
                host: process.env.BREVO_SMTP_HOST,
                port: process.env.BREVO_SMTP_PORT,
                secure: false,
                auth: {
                    user: process.env.BREVO_SMTP_USER,
                    pass: process.env.BREVO_SMTP_PASSWORD
                }
            });

            const language = order.language || order.communicationLang || 'en';
            const isSpanish = language === 'es';

            const emailHtml = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f4f4f4;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f4f4f4; padding: 20px;">
        <tr>
            <td align="center">
                <table width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                    <!-- Header -->
                    <tr>
                        <td style="background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); padding: 40px; text-align: center;">
                            <h1 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: bold;">
                                💳 ${isSpanish ? 'Completa tu Pago' : 'Complete Your Payment'}
                            </h1>
                        </td>
                    </tr>
                    
                    <!-- Content -->
                    <tr>
                        <td style="padding: 40px;">
                            <p style="font-size: 16px; color: #333; margin: 0 0 20px;">
                                ${isSpanish ? 'Hola' : 'Hello'} ${order.buyerName},
                            </p>
                            
                            <p style="font-size: 16px; color: #333; margin: 0 0 20px;">
                                ${isSpanish 
                                    ? 'Tu pedido está listo para ser procesado. Por favor completa el pago usando el siguiente enlace seguro:' 
                                    : 'Your order is ready to be processed. Please complete payment using the secure link below:'}
                            </p>
                            
                            <table width="100%" cellpadding="0" cellspacing="0" style="margin: 30px 0;">
                                <tr>
                                    <td align="center">
                                        <a href="${paymentUrl}" 
                                           style="display: inline-block; background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); color: #ffffff; text-decoration: none; padding: 16px 40px; border-radius: 8px; font-size: 18px; font-weight: bold; box-shadow: 0 4px 6px rgba(59, 130, 246, 0.3);">
                                            🔒 ${isSpanish ? 'Pagar Ahora' : 'Pay Now'} - ${formatPriceDisplay(order.totalCents)}
                                        </a>
                                    </td>
                                </tr>
                            </table>
                            
                            <p style="font-size: 14px; color: #666; text-align: center; margin: 20px 0;">
                                🔒 ${isSpanish ? 'Pago seguro procesado por Stripe' : 'Secure payment powered by Stripe'}
                            </p>
                            
                            <!-- Order Summary -->
                            <div style="background-color: #f9fafb; border-radius: 8px; padding: 20px; margin: 20px 0;">
                                <h3 style="margin: 0 0 15px; color: #333; font-size: 18px;">
                                    📦 ${isSpanish ? 'Resumen del Pedido' : 'Order Summary'}
                                </h3>
                                <p style="margin: 5px 0; color: #666; font-size: 14px;">
                                    <strong>${isSpanish ? 'Pedido' : 'Order'}:</strong> #${orderId.substring(0, 8)}
                                </p>
                                <p style="margin: 5px 0; color: #666; font-size: 14px;">
                                    <strong>${isSpanish ? 'Total' : 'Total'}:</strong> ${formatPriceDisplay(order.totalCents)}
                                </p>
                            </div>
                            
                            <p style="font-size: 14px; color: #666; margin: 20px 0 0;">
                                ${isSpanish 
                                    ? '¿Preguntas? Responde a este email o contáctanos en ' 
                                    : 'Questions? Reply to this email or contact us at '}
                                <a href="mailto:support@autoinx.com" style="color: #3b82f6;">support@autoinx.com</a>
                            </p>
                        </td>
                    </tr>
                    
                    <!-- Footer -->
                    <tr>
                        <td style="background-color: #f9fafb; padding: 20px; text-align: center; border-top: 1px solid #e5e7eb;">
                            <p style="margin: 0; color: #999; font-size: 12px;">
                                © 2025 AutoInx. ${isSpanish ? 'Todos los derechos reservados.' : 'All rights reserved.'}
                            </p>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>
            `;

            await transporter.sendMail({
                from: `"AutoInx" <${process.env.BREVO_SMTP_USER}>`,
                to: order.buyerEmail,
                subject: isSpanish 
                    ? `💳 Completa el Pago - Pedido #${orderId.substring(0, 8)}` 
                    : `💳 Complete Your Payment - Order #${orderId.substring(0, 8)}`,
                html: emailHtml
            });

            console.log('✅ Email sent to:', order.buyerEmail);

            // Update order with email sent timestamp
            await orderRef.update({
                paymentLinkSentAt: admin.firestore.FieldValue.serverTimestamp()
            });
        }

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify({
                success: true,
                paymentUrl: paymentUrl,
                paymentLinkId: paymentLinkId,
                emailSent: sendEmail
            })
        };

    } catch (error) {
        console.error('❌ Error in resendPaymentLink:', error);
        return {
            statusCode: 500,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify({
                error: 'Failed to process payment link',
                details: error.message
            })
        };
    }
};

// Helper function
function formatPriceDisplay(cents) {
    return `$${(cents / 100).toFixed(2)}`;
}
