/**
 * Netlify Function: send-email.js
 * Handles Inventory Deduction via Firestore Transaction and Email Notifications.
 */
const admin = require("firebase-admin");
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

// --- 2. Configuration and Rate Limiting ---
const rateLimitStore = {}; 
const MAX_REQUESTS_PER_HOUR = 20;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

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
        style: 'currency', currency: 'USD', minimumFractionDigits: 2
    }).format(cents / 100);
}

async function getTemplateHtml(languageCode) {
    let filename = (languageCode === 'es') 
        ? "orderConfirmationTemplateSpanish.html" 
        : "orderConfirmationTemplate.html";
    try {
        const templatePath = path.resolve(__dirname, "emailTemplates", filename);
        return await fs.readFile(templatePath, "utf8");
    } catch (error) {
        if (languageCode !== 'en') return getTemplateHtml('en');
        throw new Error(`Failed to load email template: ${filename}`);
    }
}

function generateTableRows(items) {
    return items.map(item => {
        const subtotal = item.price * item.quantity;
        return `
            <tr>
                <td style="padding: 12px; border-bottom: 1px solid #eee;">${item.name}</td>
                <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: right;">${item.quantity}</td>
                <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: right;">${formatPrice(item.price)}</td>
                <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: right;">${formatPrice(subtotal)}</td>
            </tr>`;
    }).join('');
}

async function populateTemplate(orderData, recipientType) {
    const languageCode = orderData.language || 'en';
    const orderStatus = orderData.newStatus || 'Confirmed'; 
    const orderIdShort = orderData.orderId.substring(0, 5);
    let template = await getTemplateHtml(languageCode); 

    let mainTitle, mainIntro, badgeText, badgeColor, closeMessage, subjectLine;

    if (languageCode === 'es') {
        subjectLine = "Su pedido autoInx ha sido Confirmado";
        mainTitle = "¡Gracias por su pedido!";
        mainIntro = `Hola ${orderData.buyerName}, hemos recibido su pedido #${orderIdShort}.`;
        badgeText = "✓ Pedido Confirmado";
        badgeColor = "#10b981";
        closeMessage = `Recibirá otro correo cuando su pedido sea enviado.`;
    } else {
        subjectLine = "Your autoInx Order is Confirmed";
        mainTitle = "Thank you for your order!";
        mainIntro = `Hello ${orderData.buyerName}, we've received your order #${orderIdShort}.`;
        badgeText = "✓ Order Confirmed";
        badgeColor = "#10b981"; 
        closeMessage = `You’ll receive another email when your order ships.`;
    }

    if (recipientType !== 'customer') {
        subjectLine = `NEW ORDER #${orderData.orderId.substring(0, 8).toUpperCase()}`;
        mainIntro = "Internal notification. Stock has been deducted.";
        closeMessage = 'Internal admin copy.';
    }

    template = template.replace(/{{params\.badgeColor}}/g, badgeColor)
                       .replace(/{{params\.badgeText}}/g, badgeText)
                       .replace(/{{params\.mainTitle}}/g, mainTitle)
                       .replace(/{{params\.mainIntro}}/g, mainIntro)
                       .replace(/{{params\.closeMessage}}/g, closeMessage)
                       .replace(/{{params\.orderId}}/g, orderData.orderId)
                       .replace(/{{params\.orderTableRows}}/g, generateTableRows(orderData.items))
                       .replace(/{{params\.totalPrice}}/g, formatPrice(orderData.totalCents))
                       .replace(/{{contact\.EMAIL}}/g, orderData.buyerEmail);

    return { html: template, subject: subjectLine };
}

// --- 4. Inventory Transaction Logic ---

async function decrementInventory(items) {
    try {
        await db.runTransaction(async (transaction) => {
            // Map each item to a read promise within the transaction
            const itemReads = items.map(item => {
                if (!item.catalogId) throw new Error(`Missing catalogId for ${item.name}`);
                const ref = db.collection("items").doc(item.catalogId);
                return transaction.get(ref);
            });

            const docs = await Promise.all(itemReads);

            docs.forEach((doc, index) => {
                const requestedQty = items[index].quantity;
                if (!doc.exists) throw new Error(`Product ${items[index].name} not found in database.`);
                
                const currentStock = doc.data().stock || 0;
                if (currentStock < requestedQty) {
                    throw new Error(`Insufficient stock for ${doc.data().name}. Available: ${currentStock}, Requested: ${requestedQty}`);
                }

                transaction.update(doc.ref, {
                    stock: currentStock - requestedQty,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
            });
        });
        return { success: true };
    } catch (err) {
        console.error("Inventory Transaction Failed:", err.message);
        return { success: false, error: err.message };
    }
}

// --- 5. Main Handler ---

exports.handler = async function (event) {
    if (event.httpMethod !== "POST") {
        return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
    }

    const clientIp = event.headers['client-ip'] || 'unknown';
    const now = Date.now();
    if (!rateLimitStore[clientIp]) rateLimitStore[clientIp] = [];
    rateLimitStore[clientIp] = rateLimitStore[clientIp].filter(t => t > now - RATE_LIMIT_WINDOW_MS);
    
    if (rateLimitStore[clientIp].length >= MAX_REQUESTS_PER_HOUR) {
        return { statusCode: 429, body: JSON.stringify({ error: "Rate limit exceeded." }) };
    }
    rateLimitStore[clientIp].push(now);

    const orderData = JSON.parse(event.body);
    const { orderId, buyerEmail, items, totalCents, communicationLang } = orderData;

    if (!orderId || !items || items.length === 0) {
        return { statusCode: 400, body: JSON.stringify({ error: "Missing order data." }) };
    }

    try {
        // STEP 1: DECREASE STOCK
        const inventoryResult = await decrementInventory(items);
        if (!inventoryResult.success) {
            return {
                statusCode: 409, // Conflict / Stock Issue
                body: JSON.stringify({ error: inventoryResult.error })
            };
        }

        // STEP 2: PREPARE EMAILS
        const langPayload = { language: communicationLang };
        const customerData = await populateTemplate({ ...orderData, ...langPayload }, 'customer');
        const adminData = await populateTemplate({ ...orderData, ...langPayload }, 'admin');

        // STEP 3: SEND EMAILS
        await transporter.sendMail({
            from: "noreply@autoinx.com",
            to: buyerEmail,
            subject: customerData.subject,
            html: customerData.html
        });

        await transporter.sendMail({
            from: "noreply@autoinx.com",
            to: "orders@autoinx.com",
            subject: adminData.subject,
            html: adminData.html
        });

        return {
            statusCode: 200,
            body: JSON.stringify({ message: "Stock updated and emails sent.", orderId })
        };

    } catch (error) {
        console.error("Function Error:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "Server Error", details: error.message })
        };
    }
};
