/**
 * Netlify Function: send-email.js
 * Handles Inventory Deduction via Deeply Nested Firestore Path and Email Notifications.
 * Optimized with Lazy Firebase Initialization to prevent bundling errors.
 */
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const fs = require("fs").promises;
const path = require("path");

// --- 1. Global Rate Limiting State ---
const rateLimitStore = {}; 
const MAX_REQUESTS_PER_HOUR = 20;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

// --- 2. Robust Firebase Initialization ---
/**
 * Ensures Firebase is only initialized once and only when needed.
 * This prevents "Default app does not exist" errors during esbuild bundling.
 */
function getDb() {
    if (admin.apps.length === 0) {
        if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
            throw new Error("Missing FIREBASE_SERVICE_ACCOUNT environment variable.");
        }
        try {
            const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            console.log("Firebase Admin Initialized successfully.");
        } catch (error) {
            console.error("Firebase Admin initialization failed:", error);
            throw error;
        }
    }
    return admin.firestore();
}

// --- 3. Configuration & Transporter ---
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
        console.error(`Error reading template ${filename}:`, error);
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
    const db = getDb(); // Get initialized Firestore instance
    const collectionPath = `artifacts/${appId}/public/data/items`;
    
    try {
        await db.runTransaction(async (transaction) => {
            // Step A: Prepare all document references
            const itemRefs = items.map(item => {
                const docId = item.itemId || item.id; 
                if (!docId) throw new Error(`Missing Document ID for item: ${item.name}`);
                return db.collection(collectionPath).doc(docId);
            });

            // Step B: Read all documents (within the transaction)
            const docs = await Promise.all(itemRefs.map(ref => transaction.get(ref)));

            // Step C: Validate and Update
            docs.forEach((doc, index) => {
                if (!doc.exists) {
                    throw new Error(`Item not found in database: ${items[index].name}`);
                }

                const currentStock = doc.data().stock || 0;
                const requestedQty = items[index].quantity;

                if (currentStock < requestedQty) {
                    throw new Error(`Insufficient stock for ${doc.data().name}. Available: ${currentStock}, Requested: ${requestedQty}`);
                }

                // Execute the update inside the transaction
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

// --- 6. Main Handler ---

exports.handler = async function (event) {
    if (event.httpMethod !== "POST") {
        return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
    }

    // Rate Limiting Logic
    const clientIp = event.headers['client-ip'] || event.headers['x-nf-client-connection-ip'] || 'unknown';
    const now = Date.now();
    if (!rateLimitStore[clientIp]) rateLimitStore[clientIp] = [];
    rateLimitStore[clientIp] = rateLimitStore[clientIp].filter(t => t > now - RATE_LIMIT_WINDOW_MS);
    if (rateLimitStore[clientIp].length >= MAX_REQUESTS_PER_HOUR) {
        return { 
            statusCode: 429, 
            body: JSON.stringify({ error: "Rate limit exceeded. Please wait one hour." }) 
        };
    }
    rateLimitStore[clientIp].push(now);

    try {
        const orderData = JSON.parse(event.body);
        const { orderId, buyerEmail, buyerName, items, totalCents, communicationLang, appId } = orderData;

        // Basic Validation
        if (!orderId || !items || items.length === 0) {
            return { statusCode: 400, body: JSON.stringify({ error: "Missing required order data." }) };
        }

        // STEP 1: Deduct Inventory
        // This transaction blocks the email and confirmation if stock is unavailable.
        const inventoryResult = await decrementInventory(items, appId);
        if (!inventoryResult.success) {
            return {
                statusCode: 409, // Conflict (Stock Issue)
                body: JSON.stringify({ error: inventoryResult.error })
            };
        }

        // STEP 2: Generate Email Content
        const languageCode = communicationLang || 'es';
        let template = await getTemplateHtml(languageCode);
        
        // Define Dynamic Content
        const badgeColor = "#10b981"; // Emerald Green
        const badgeText = languageCode === 'es' ? "✓ Pedido Confirmado" : "✓ Order Confirmed";
        const mainTitle = languageCode === 'es' ? "¡Gracias por su pedido!" : "Thank you for your order!";
        const mainIntro = languageCode === 'es' 
            ? `Hola ${buyerName}, hemos recibido su pedido #${orderId.substring(0, 8)}.` 
            : `Hello ${buyerName}, we've received your order #${orderId.substring(0, 8)}.`;
        const closeMessage = languageCode === 'es'
            ? "Recibirá otro correo cuando su pedido sea enviado."
            : "You’ll receive another email when your order ships.";

        // Perform Replacements
        template = template
            .replace(/{{params\.badgeColor}}/g, badgeColor)
            .replace(/{{params\.badgeText}}/g, badgeText)
            .replace(/{{params\.mainTitle}}/g, mainTitle)
            .replace(/{{params\.mainIntro}}/g, mainIntro)
            .replace(/{{params\.closeMessage}}/g, closeMessage)
            .replace(/{{params\.orderId}}/g, orderId)
            .replace(/{{params\.orderTableRows}}/g, generateTableRows(items))
            .replace(/{{params\.totalPrice}}/g, formatPrice(totalCents))
            .replace(/{{contact\.EMAIL}}/g, buyerEmail);

        // STEP 3: Send Emails
        const customerMailOptions = {
            from: "noreply@autoinx.com",
            to: buyerEmail,
            subject: languageCode === 'es' ? "Confirmación de Pedido - autoInx" : "Order Confirmation - autoInx",
            html: template
        };

        // Send to Customer
        await transporter.sendMail(customerMailOptions);
        
        // Send to Admin
        await transporter.sendMail({
            ...customerMailOptions,
            to: "orders@autoinx.com",
            subject: `[NEW ORDER] #${orderId.substring(0,8)} - ${buyerName}`
        });

        return {
            statusCode: 200,
            body: JSON.stringify({ message: "Stock updated and emails sent successfully.", orderId })
        };

    } catch (error) {
        console.error("Function Execution Failed:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "Failed to process order", details: error.message })
        };
    }
};
