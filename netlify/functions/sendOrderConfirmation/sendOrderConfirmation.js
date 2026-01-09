/**
 * Netlify Function: send-email.js
 * Handles Inventory Deduction via Deeply Nested Firestore Path and Email Notifications.
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
        console.error("Firebase Admin initialization failed:", err);
    }
}
const db = admin.firestore();

// --- 2. Configuration & Rate Limiting ---
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

// --- 3. Formatting Helpers ---

function formatPrice(cents) {
    return new Intl.NumberFormat('en-US', {
        style: 'currency', currency: 'USD', minimumFractionDigits: 2
    }).format(cents / 100);
}

async function getTemplateHtml(languageCode) {
    const filename = (languageCode === 'es') 
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
    return items.map(item => `
        <tr>
            <td style="padding: 12px; border-bottom: 1px solid #eee;">${item.name}</td>
            <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: right;">${item.quantity}</td>
            <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: right;">${formatPrice(item.price)}</td>
            <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: right;">${formatPrice(item.price * item.quantity)}</td>
        </tr>`).join('');
}

// --- 4. Inventory Transaction Logic ---



async function decrementInventory(items, appId = 'default-app-id') {
    // Exact path to your items subcollection
    const collectionPath = `artifacts/${appId}/public/data/items`;
    
    try {
        await db.runTransaction(async (transaction) => {
            const itemRefs = items.map(item => {
                // We use itemId (the Firestore Doc ID like 02pjNxSUvYM0OzSpJnw1)
                const docId = item.itemId || item.id; 
                if (!docId) throw new Error(`Missing Document ID for item: ${item.name}`);
                return db.collection(collectionPath).doc(docId);
            });

            const docs = await Promise.all(itemRefs.map(ref => transaction.get(ref)));

            docs.forEach((doc, index) => {
                if (!doc.exists) {
                    throw new Error(`Item not found in database: ${items[index].name}`);
                }

                const currentStock = doc.data().stock || 0;
                const requestedQty = items[index].quantity;

                if (currentStock < requestedQty) {
                    throw new Error(`Insufficient stock for ${doc.data().name}. Available: ${currentStock}, Requested: ${requestedQty}`);
                }

                // Execute the update
                transaction.update(doc.ref, {
                    stock: currentStock - requestedQty,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
            });
        });
        return { success: true };
    } catch (err) {
        console.error("Inventory Deduction Error:", err.message);
        return { success: false, error: err.message };
    }
}

// --- 5. Main Handler ---

exports.handler = async function (event) {
    if (event.httpMethod !== "POST") {
        return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
    }

    // Rate Limiting
    const clientIp = event.headers['client-ip'] || 'unknown';
    const now = Date.now();
    if (!rateLimitStore[clientIp]) rateLimitStore[clientIp] = [];
    rateLimitStore[clientIp] = rateLimitStore[clientIp].filter(t => t > now - RATE_LIMIT_WINDOW_MS);
    if (rateLimitStore[clientIp].length >= MAX_REQUESTS_PER_HOUR) {
        return { statusCode: 429, body: JSON.stringify({ error: "Rate limit exceeded." }) };
    }
    rateLimitStore[clientIp].push(now);

    try {
        const orderData = JSON.parse(event.body);
        const { orderId, buyerEmail, items, totalCents, communicationLang, appId } = orderData;

        // STEP 1: Deduct Inventory
        // This blocks the email and confirmation if stock is unavailable
        const inventoryResult = await decrementInventory(items, appId);
        if (!inventoryResult.success) {
            return {
                statusCode: 409, 
                body: JSON.stringify({ error: inventoryResult.error })
            };
        }

        // STEP 2: Generate Email Content
        const languageCode = communicationLang || 'es';
        let template = await getTemplateHtml(languageCode);
        
        // Dynamic Replacement Logic
        const replacements = {
            "{{params.orderId}}": orderId,
            "{{params.orderTableRows}}": generateTableRows(items),
            "{{params.totalPrice}}": formatPrice(totalCents),
            "{{params.badgeText}}": languageCode === 'es' ? "✓ Pedido Confirmado" : "✓ Order Confirmed",
            "{{params.badgeColor}}": "#10b981",
            "{{params.mainTitle}}": languageCode === 'es' ? "¡Gracias por su pedido!" : "Thank you for your order!",
            "{{contact.EMAIL}}": buyerEmail
        };

        Object.keys(replacements).forEach(key => {
            const regex = new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
            template = template.replace(regex, replacements[key]);
        });

        // STEP 3: Send Emails
        const mailOptions = {
            from: "noreply@autoinx.com",
            to: buyerEmail,
            subject: languageCode === 'es' ? "Confirmación de Pedido - autoInx" : "Order Confirmation - autoInx",
            html: template
        };

        await transporter.sendMail(mailOptions);
        
        // Admin Copy
        await transporter.sendMail({
            ...mailOptions,
            to: "orders@autoinx.com",
            subject: `[NEW ORDER] #${orderId.substring(0,8)}`
        });

        return {
            statusCode: 200,
            body: JSON.stringify({ message: "Success", orderId })
        };

    } catch (error) {
        console.error("Function Execution Failed:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "Failed to process order", details: error.message })
        };
    }
};
