/**
 * Netlify Function: send-email.js
 * Handles Inventory Deduction via Deeply Nested Firestore Path and Email Notifications.
 * Optimized for existing individual Firebase environment variables.
 */
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const fs = require("fs").promises;
const path = require("path");

// --- 1. Global Rate Limiting ---
const rateLimitStore = {}; 
const MAX_REQUESTS_PER_HOUR = 20;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

// --- 2. Robust Firebase Initialization ---
function getDb() {
    if (admin.apps.length === 0) {
        try {
            // Reconstruct the service account from your existing Netlify variables
            const serviceAccount = {
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                // Fixes the common Netlify/esbuild private key newline issue
                privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            };

            if (!serviceAccount.projectId || !serviceAccount.privateKey) {
                throw new Error("Missing critical Firebase environment variables.");
            }

            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount),
                databaseURL: process.env.FIREBASE_DATABASE_URL
            });
            console.log("Firebase Admin Initialized successfully.");
        } catch (error) {
            console.error("Firebase Admin initialization failed:", error);
            throw error;
        }
    }
    return admin.firestore();
}

// --- 3. Transporter Configuration ---
const transporter = nodemailer.createTransport({
    host: process.env.BREVO_SMTP_HOST,
    port: process.env.BREVO_SMTP_PORT,
    secure: false,
    auth: {
        user: process.env.BREVO_SMTP_USER,
        pass: process.env.BREVO_SMTP_PASSWORD,
    },
});

// --- 4. Helpers ---

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
            <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: left; font-size: 14px;">${item.name}</td>
            <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: right; font-size: 14px;">${item.quantity}</td>
            <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: right; font-size: 14px;">${formatPrice(item.price)}</td>
            <td style="padding: 12px; border-bottom: 1px solid #eee; text-align: right; font-size: 14px;">${formatPrice(item.price * item.quantity)}</td>
        </tr>`).join('');
}

// --- 5. Inventory Transaction Logic ---

async function decrementInventory(items, appId = 'default-app-id') {
    const db = getDb();
    // Your exact path: artifacts/{id}/public/data/items
    const collectionPath = `artifacts/${appId}/public/data/items`;
    
    try {
        await db.runTransaction(async (transaction) => {
            const itemRefs = items.map(item => {
                const docId = item.itemId || item.id; 
                if (!docId) throw new Error(`Missing Document ID for: ${item.name}`);
                return db.collection(collectionPath).doc(docId);
            });

            const docs = await Promise.all(itemRefs.map(ref => transaction.get(ref)));

            docs.forEach((doc, index) => {
                if (!doc.exists) throw new Error(`Product not found: ${items[index].name}`);

                const currentStock = doc.data().stock || 0;
                const requestedQty = items[index].quantity;

                if (currentStock < requestedQty) {
                    throw new Error(`Stock insuficiente para ${doc.data().name}. Disponible: ${currentStock}`);
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

// --- 6. Main Handler ---

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
        const { orderId, buyerEmail, buyerName, items, totalCents, communicationLang, appId } = orderData;

        // Ensure DB is initialized
        getDb();

        // STEP 1: Deduct Inventory
        const inventoryResult = await decrementInventory(items, appId);
        if (!inventoryResult.success) {
            return {
                statusCode: 409, // Conflict (Stock Issue)
                body: JSON.stringify({ error: inventoryResult.error })
            };
        }

        // STEP 2: Prepare Email
        const languageCode = communicationLang || 'es';
        let template = await getTemplateHtml(languageCode);
        
        const badgeText = languageCode === 'es' ? "✓ Pedido Confirmado" : "✓ Order Confirmed";
        const mainTitle = languageCode === 'es' ? "¡Gracias por su pedido!" : "Thank you for your order!";
        const mainIntro = languageCode === 'es' 
            ? `Hola ${buyerName}, hemos recibido su pedido #${orderId.substring(0, 8)}.` 
            : `Hello ${buyerName}, we've received your order #${orderId.substring(0, 8)}.`;

        template = template
            .replace(/{{params\.badgeColor}}/g, "#10b981")
            .replace(/{{params\.badgeText}}/g, badgeText)
            .replace(/{{params\.mainTitle}}/g, mainTitle)
            .replace(/{{params\.mainIntro}}/g, mainIntro)
            .replace(/{{params\.orderId}}/g, orderId)
            .replace(/{{params\.orderTableRows}}/g, generateTableRows(items))
            .replace(/{{params\.totalPrice}}/g, formatPrice(totalCents))
            .replace(/{{contact\.EMAIL}}/g, buyerEmail);

        // STEP 3: Send
        const mailOptions = {
            from: "noreply@autoinx.com",
            to: buyerEmail,
            subject: languageCode === 'es' ? "Confirmación de Pedido - autoInx" : "Order Confirmation - autoInx",
            html: template
        };

        await transporter.sendMail(mailOptions);
        await transporter.sendMail({ ...mailOptions, to: "orders@autoinx.com", subject: `[NEW ORDER] #${orderId.substring(0,8)}` });

        return {
            statusCode: 200,
            body: JSON.stringify({ message: "Stock updated and emails sent.", orderId })
        };

    } catch (error) {
        console.error("Function Error:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "Failed to process order", details: error.message })
        };
    }
};
