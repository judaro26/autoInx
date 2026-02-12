const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

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

const transporter = nodemailer.createTransport({
    host: process.env.BREVO_SMTP_HOST,
    port: process.env.BREVO_SMTP_PORT,
    secure: false,
    auth: {
        user: process.env.BREVO_SMTP_USER,
        pass: process.env.BREVO_SMTP_PASSWORD,
    },
});

exports.handler = async function(event) {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    // ✅ Admin authentication check
    const authHeader = event.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    const idToken = authHeader.split('Bearer ')[1];
    
    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        if (!decodedToken.admin) {
            return { statusCode: 403, body: JSON.stringify({ error: 'Admin access required' }) };
        }
    } catch (error) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid token' }) };
    }

    try {
        const { orderId, sendEmail = true } = JSON.parse(event.body);

        if (!orderId) {
            return { statusCode: 400, body: JSON.stringify({ error: 'orderId required' }) };
        }

        const db = getDb();
        const orderRef = db.doc(`artifacts/default-app-id/public/data/orders/${orderId}`);
        const orderSnap = await orderRef.get();

        if (!orderSnap.exists) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Order not found' }) };
        }

        const orderData = orderSnap.data();

        // Check if order already has a payment link
        let paymentUrl = orderData.stripePaymentUrl;

        // If no payment link exists, create one
        if (!paymentUrl) {
            console.log('Creating new payment link for order:', orderId);

            const lineItems = orderData.items.map(item => ({
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: item.name,
                        metadata: {
                            sku: item.sku || '',
                            order_id: orderId
                        }
                    },
                    unit_amount: item.price,
                },
                quantity: item.quantity
            }));

            // Add shipping
            if (orderData.shippingCents > 0) {
                lineItems.push({
                    price_data: {
                        currency: 'usd',
                        product_data: { name: 'Shipping' },
                        unit_amount: orderData.shippingCents
                    },
                    quantity: 1
                });
            }

            // Add tax
            if (orderData.taxCents > 0) {
                lineItems.push({
                    price_data: {
                        currency: 'usd',
                        product_data: { name: 'Tax' },
                        unit_amount: orderData.taxCents
                    },
                    quantity: 1
                });
            }

            const paymentLink = await stripe.paymentLinks.create({
                line_items: lineItems,
                metadata: {
                    order_id: orderId,
                    buyer_email: orderData.buyerEmail,
                    integration: 'autoinx_admin_resend'
                },
                after_completion: {
                    type: 'redirect',
                    redirect: {
                        url: `${process.env.URL || 'https://autoinx.com'}/payment-success?order=${orderId}`
                    }
                },
                allow_promotion_codes: true
            });

            paymentUrl = paymentLink.url;

            // Save to order
            await orderRef.update({
                stripePaymentUrl: paymentUrl,
                stripePaymentLinkId: paymentLink.id,
                paymentLinkSentAt: admin.firestore.FieldValue.serverTimestamp()
            });
        }

        // Send email if requested
        if (sendEmail) {
            const formatPrice = (cents) => `$${(cents / 100).toFixed(2)}`;
            
            const emailHtml = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0; padding:0; background:#f8fafc; font-family:Arial, sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc; padding:40px 20px;">
        <tr>
            <td align="center">
                <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px; background:#ffffff; border-radius:12px; overflow:hidden; box-shadow:0 4px 12px rgba(0,0,0,0.1);">
                    
                    <!-- Header -->
                    <tr>
                        <td style="background:linear-gradient(135deg, #6366f1 0%, #4f46e5 100%); padding:40px 30px; text-align:center;">
                            <h1 style="color:#ffffff; margin:0; font-size:28px;">autoInx</h1>
                        </td>
                    </tr>

                    <!-- Content -->
                    <tr>
                        <td style="padding:40px 30px;">
                            <h2 style="margin:0 0 20px; font-size:24px; color:#1e293b;">Payment Reminder</h2>
                            <p style="margin:0 0 20px; font-size:16px; color:#64748b; line-height:1.6;">
                                Hello ${orderData.buyerName},
                            </p>
                            <p style="margin:0 0 30px; font-size:16px; color:#64748b; line-height:1.6;">
                                Your order <strong>#${orderId.substring(0, 8)}</strong> for <strong>${formatPrice(orderData.totalCents)}</strong> is ready to be paid.
                            </p>
                            
                            <!-- Payment Button -->
                            <table width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); border-radius:12px; overflow:hidden;">
                                <tr>
                                    <td style="padding:30px; text-align:center;">
                                        <h3 style="margin:0 0 12px; font-size:20px; color:#ffffff;">Complete Your Payment</h3>
                                        <a href="${paymentUrl}" target="_blank" style="display:inline-block; background:#ffffff; color:#2563eb; font-size:18px; font-weight:700; padding:16px 40px; border-radius:8px; text-decoration:none; margin:10px 0;">
                                            🔒 Pay Now - ${formatPrice(orderData.totalCents)}
                                        </a>
                                        <p style="margin:12px 0 0; font-size:12px; color:#dbeafe;">🔒 Secure payment powered by Stripe</p>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>

                    <!-- Footer -->
                    <tr>
                        <td style="padding:30px; text-align:center; font-size:13px; color:#94a3b8; border-top:1px solid #e2e8f0;">
                            <p style="margin:0;">© 2025 AutoInx. All rights reserved.</p>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;

            await transporter.sendMail({
                from: '"autoInx Support" <noreply@autoinx.com>',
                to: orderData.buyerEmail,
                subject: `Payment Link - Order #${orderId.substring(0, 8)}`,
                html: emailHtml
            });

            console.log('✅ Payment link email sent to:', orderData.buyerEmail);
        }

        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                paymentUrl,
                orderId,
                emailSent: sendEmail
            })
        };

    } catch (error) {
        console.error('❌ Resend Payment Link Error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: 'Failed to resend payment link',
                details: error.message
            })
        };
    }
};
