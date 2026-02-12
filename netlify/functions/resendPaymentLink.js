const admin = require("firebase-admin");
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const nodemailer = require("nodemailer");
const fs = require("fs").promises;
const path = require("path");

// --- 1. Initialize Firebase Admin ---
if (!admin.apps.length) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
    } catch (err) {
        console.error("Firebase Admin initialization failed. Check FIREBASE_SERVICE_ACCOUNT env var.");
    }
}
const db = admin.firestore();

// --- 2. Configuration ---
const transporter = nodemailer.createTransport({
    host: process.env.BREVO_SMTP_HOST,
    port: process.env.BREVO_SMTP_PORT,
    secure: false,
    auth: {
        user: process.env.BREVO_SMTP_USER,
        pass: process.env.BREVO_SMTP_PASSWORD,
    },
});

// --- 3. Helper Functions ---

function formatPrice(cents) {
    return new Intl.NumberFormat('en-US', {
        style: 'currency', 
        currency: 'USD', 
        minimumFractionDigits: 2
    }).format(cents / 100);
}

async function getPaymentTemplateHtml(languageCode) {
    let filename = (languageCode === 'es') 
        ? "paymentLinkTemplateSpanish.html" 
        : "paymentLinkTemplate.html";
    try {
        const templatePath = path.resolve(__dirname, "emailTemplates", filename);
        return await fs.readFile(templatePath, "utf8");
    } catch (error) {
        console.warn(`Template ${filename} not found, using fallback`);
        if (languageCode !== 'en') return getPaymentTemplateHtml('en');
        // Fallback inline template if file doesn't exist
        return getFallbackTemplate();
    }
}

function getFallbackTemplate() {
    return `
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
                    <tr>
                        <td style="background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); padding: 40px; text-align: center;">
                            <h1 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: bold;">
                                💳 {{params.mainTitle}}
                            </h1>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding: 40px;">
                            <p style="font-size: 16px; color: #333; margin: 0 0 20px;">
                                {{params.mainIntro}}
                            </p>
                            <table width="100%" cellpadding="0" cellspacing="0" style="margin: 30px 0;">
                                <tr>
                                    <td align="center">
                                        <a href="{{params.paymentUrl}}" 
                                           style="display: inline-block; background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); color: #ffffff; text-decoration: none; padding: 16px 40px; border-radius: 8px; font-size: 18px; font-weight: bold; box-shadow: 0 4px 6px rgba(59, 130, 246, 0.3);">
                                            🔒 {{params.buttonText}}
                                        </a>
                                    </td>
                                </tr>
                            </table>
                            <p style="font-size: 14px; color: #666; text-align: center; margin: 20px 0;">
                                {{params.secureText}}
                            </p>
                            <div style="background-color: #f9fafb; border-radius: 8px; padding: 20px; margin: 20px 0;">
                                <h3 style="margin: 0 0 15px; color: #333; font-size: 18px;">
                                    📦 {{params.summaryTitle}}
                                </h3>
                                <p style="margin: 5px 0; color: #666; font-size: 14px;">
                                    <strong>{{params.orderLabel}}:</strong> #{{params.orderId}}
                                </p>
                                <p style="margin: 5px 0; color: #666; font-size: 14px;">
                                    <strong>{{params.totalLabel}}:</strong> {{params.totalPrice}}
                                </p>
                            </div>
                            <p style="font-size: 14px; color: #666; margin: 20px 0 0;">
                                {{params.closeMessage}}
                            </p>
                        </td>
                    </tr>
                    <tr>
                        <td style="background-color: #f9fafb; padding: 20px; text-align: center; border-top: 1px solid #e5e7eb;">
                            <p style="margin: 0; color: #999; font-size: 12px;">
                                © 2025 AutoInx. {{params.rightsText}}
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
}

async function populatePaymentTemplate(orderData, paymentUrl) {
    const languageCode = orderData.language || orderData.communicationLang || 'en';
    const orderIdShort = orderData.orderId.substring(0, 8);
    let template = await getPaymentTemplateHtml(languageCode);

    let mainTitle, mainIntro, buttonText, secureText, summaryTitle, 
        orderLabel, totalLabel, closeMessage, rightsText, subjectLine;

    if (languageCode === 'es') {
        subjectLine = `💳 Completa el Pago - Pedido #${orderIdShort}`;
        mainTitle = "Completa tu Pago";
        mainIntro = `Hola ${orderData.buyerName}, tu pedido está listo para ser procesado. Por favor completa el pago usando el siguiente enlace seguro:`;
        buttonText = `Pagar Ahora - ${formatPrice(orderData.totalCents)}`;
        secureText = "🔒 Pago seguro procesado por Stripe";
        summaryTitle = "Resumen del Pedido";
        orderLabel = "Pedido";
        totalLabel = "Total";
        closeMessage = "¿Preguntas? Responde a este email o contáctanos en support@autoinx.com";
        rightsText = "Todos los derechos reservados.";
    } else {
        subjectLine = `💳 Complete Your Payment - Order #${orderIdShort}`;
        mainTitle = "Complete Your Payment";
        mainIntro = `Hello ${orderData.buyerName}, your order is ready to be processed. Please complete payment using the secure link below:`;
        buttonText = `Pay Now - ${formatPrice(orderData.totalCents)}`;
        secureText = "🔒 Secure payment powered by Stripe";
        summaryTitle = "Order Summary";
        orderLabel = "Order";
        totalLabel = "Total";
        closeMessage = "Questions? Reply to this email or contact us at support@autoinx.com";
        rightsText = "All rights reserved.";
    }

    template = template.replace(/{{params\.mainTitle}}/g, mainTitle)
                       .replace(/{{params\.mainIntro}}/g, mainIntro)
                       .replace(/{{params\.buttonText}}/g, buttonText)
                       .replace(/{{params\.paymentUrl}}/g, paymentUrl)
                       .replace(/{{params\.secureText}}/g, secureText)
                       .replace(/{{params\.summaryTitle}}/g, summaryTitle)
                       .replace(/{{params\.orderLabel}}/g, orderLabel)
                       .replace(/{{params\.totalLabel}}/g, totalLabel)
                       .replace(/{{params\.orderId}}/g, orderIdShort)
                       .replace(/{{params\.totalPrice}}/g, formatPrice(orderData.totalCents))
                       .replace(/{{params\.closeMessage}}/g, closeMessage)
                       .replace(/{{params\.rightsText}}/g, rightsText);

    return { html: template, subject: subjectLine };
}

// --- 4. Stripe Payment Link Creation ---

async function createOrRetrievePaymentLink(order) {
    // Check if payment link already exists and is still valid
    if (order.stripePaymentUrl && order.stripePaymentLinkId) {
        console.log('✅ Using existing payment link:', order.stripePaymentLinkId);
        return {
            url: order.stripePaymentUrl,
            id: order.stripePaymentLinkId
        };
    }

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
                url: `${process.env.URL}/payment-success.html?order=${order.orderId}`
            }
        },
        metadata: {
            order_id: order.orderId,
            buyer_email: order.buyerEmail,
            buyer_name: order.buyerName
        },
        custom_text: {
            submit: { message: `Order #${order.orderId.substring(0, 8)}` }
        },
        invoice_creation: {
            enabled: true,
            invoice_data: {
                description: `AutoInx Order #${order.orderId.substring(0, 8)}`,
                metadata: { order_id: order.orderId },
                custom_fields: [
                    { name: 'Order ID', value: order.orderId.substring(0, 8) }
                ]
            }
        }
    });

    console.log('✅ Payment link created:', paymentLink.id);

    return {
        url: paymentLink.url,
        id: paymentLink.id
    };
}

// --- 5. Main Handler ---

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') {
        return { 
            statusCode: 405, 
            body: JSON.stringify({ error: 'Method not allowed' }) 
        };
    }

    // ✅ ADMIN TOKEN VERIFICATION
    try {
        const authHeader = event.headers.authorization || event.headers.Authorization;
        
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            console.error('❌ No authorization header found');
            return {
                statusCode: 401,
                body: JSON.stringify({ error: 'No authorization token provided' })
            };
        }

        const token = authHeader.replace('Bearer ', '');
        
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

        if (!decodedToken.admin) {
            console.error('❌ User is not an admin:', decodedToken.uid);
            return {
                statusCode: 403,
                body: JSON.stringify({ error: 'Admin access required' })
            };
        }

        console.log('✅ Admin verified:', decodedToken.email);

    } catch (authError) {
        console.error('❌ Authentication error:', authError);
        return {
            statusCode: 401,
            body: JSON.stringify({ error: 'Authentication failed' })
        };
    }

    // Parse request body
    const { orderId, sendEmail = true } = JSON.parse(event.body);

    if (!orderId) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: 'orderId is required' })
        };
    }

    console.log('📦 Processing payment link for order:', orderId);

    try {
        // STEP 1: GET ORDER FROM FIRESTORE
        const appId = process.env.APP_ID || 'default-app-id';
        const orderRef = db.doc(`artifacts/${appId}/public/data/orders/${orderId}`);
        const orderSnap = await orderRef.get();

        if (!orderSnap.exists) {
            return {
                statusCode: 404,
                body: JSON.stringify({ error: 'Order not found' })
            };
        }

        const orderData = { orderId, ...orderSnap.data() };
        console.log('✅ Order found:', orderData.buyerEmail);

        // STEP 2: CREATE/RETRIEVE PAYMENT LINK
        const paymentLink = await createOrRetrievePaymentLink(orderData);

        // Save to Firestore if it's a new link
        if (!orderData.stripePaymentUrl) {
            await orderRef.update({
                stripePaymentUrl: paymentLink.url,
                stripePaymentLinkId: paymentLink.id,
                paymentLinkCreatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
        }

        // STEP 3: SEND EMAIL (if requested)
        if (sendEmail) {
            console.log('📧 Sending payment link email...');

            const emailContent = await populatePaymentTemplate(orderData, paymentLink.url);

            await transporter.sendMail({
                from: `"AutoInx" <${process.env.BREVO_SMTP_USER}>`,
                to: orderData.buyerEmail,
                subject: emailContent.subject,
                html: emailContent.html
            });

            console.log('✅ Email sent to:', orderData.buyerEmail);

            // Update order with email sent timestamp
            await orderRef.update({
                paymentLinkSentAt: admin.firestore.FieldValue.serverTimestamp()
            });
        }

        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                paymentUrl: paymentLink.url,
                paymentLinkId: paymentLink.id,
                emailSent: sendEmail
            })
        };

    } catch (error) {
        console.error('❌ Function Error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: 'Server Error',
                details: error.message
            })
        };
    }
};
