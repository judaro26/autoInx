/**
 * Netlify Function: send-email.js
 * Handles Inventory Deduction and Email Notifications for New Orders & Status Updates.
 */
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const fs = require("fs").promises;
const path = require("path");

// --- 1. Global Rate Limiting ---
const rateLimitStore = {}; 
const MAX_REQUESTS_PER_HOUR = 30;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

// --- 2. Firebase Admin Initialization ---
function getDb() {
    if (admin.apps.length === 0) {
        try {
            const serviceAccount = {
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            };

            if (!serviceAccount.projectId || !serviceAccount.privateKey) {
                throw new Error("Missing critical Firebase environment variables.");
            }

            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount),
                databaseURL: process.env.FIREBASE_DATABASE_URL
            });
            console.log("Firebase Admin Initialized.");
        } catch (error) {
            console.error("Firebase Admin initialization failed:", error);
            throw error;
        }
    }
    return admin.firestore();
}

// --- 3. Transporter Configuration (SMTP) ---
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
        console.warn(`Template ${filename} not found, falling back to English.`);
        const fallbackPath = path.resolve(__dirname, "emailTemplates", "orderConfirmationTemplate.html");
        return await fs.readFile(fallbackPath, "utf8");
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
                    throw new Error(`Insufficient stock for ${doc.data().name}. Available: ${currentStock}`);
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
        const { orderId, buyerEmail, buyerName, items, totalCents, communicationLang, appId, newStatus } = orderData;

        // Ensure DB is initialized
        getDb();

        // STEP 1: Inventory Management
        // Only decrement inventory for NEW orders (when newStatus is NOT present)
        if (!newStatus) {
            const inventoryResult = await decrementInventory(items, appId);
            if (!inventoryResult.success) {
                return { statusCode: 409, body: JSON.stringify({ error: inventoryResult.error }) };
            }
        }

        // STEP 2: Prepare Email Content Logic
        const languageCode = communicationLang || 'en';
        let template = await getTemplateHtml(languageCode);

        // Status Configuration for Styling
        const statusConfig = {
            'Pending': { color: "#ef4444", en: "Pending", es: "Pendiente" },
            'Processing': { color: "#3b82f6", en: "Processing", es: "Procesando" },
            'Shipped': { color: "#8b5cf6", en: "Shipped", es: "Enviado" },
            'Delivered': { color: "#10b981", en: "Delivered", es: "Entregado" },
            'Cancelled': { color: "#64748b", en: "Cancelled", es: "Cancelado" }
        };

        const isStatusUpdate = !!newStatus;
        const currentStatus = newStatus || "Pending";
        const config = statusConfig[currentStatus] || statusConfig['Pending'];
        const badgeColor = config.color;
        const statusText = languageCode === 'es' ? config.es : config.en;

        let badgeLabel, mainTitle, mainIntro, closeMsg;

        if (isStatusUpdate) {
            badgeLabel = languageCode === 'es' ? `Actualización: ${statusText}` : `Update: ${statusText}`;
            mainTitle = languageCode === 'es' ? "Actualización de su Pedido" : "Order Status Update";
            mainIntro = languageCode === 'es' 
                ? `Hola ${buyerName}, el estado de su pedido #${orderId.substring(0, 8)} ha cambiado a: <strong>${statusText}</strong>.`
                : `Hello ${buyerName}, the status of your order #${orderId.substring(0, 8)} has been updated to: <strong>${statusText}</strong>.`;
            closeMsg = languageCode === 'es' ? "Le avisaremos cuando haya más novedades." : "We will notify you of further updates.";
        } else {
            badgeLabel = languageCode === 'es' ? "✓ Pedido Confirmado" : "✓ Order Confirmed";
            mainTitle = languageCode === 'es' ? "¡Gracias por su pedido!" : "Thank you for your order!";
            mainIntro = languageCode === 'es' 
                ? `Hola ${buyerName}, hemos recibido su pedido #${orderId.substring(0, 8)}.` 
                : `Hello ${buyerName}, we've received your order #${orderId.substring(0, 8)}.`;
            closeMsg = languageCode === 'es' ? "¡Gracias por elegir autoInx!" : "Thanks for choosing autoInx!";
        }

        // STEP 3: Replace placeholders in HTML
        template = template
            .replace(/{{params\.badgeColor}}/g, badgeColor)
            .replace(/{{params\.badgeText}}/g, badgeLabel)
            .replace(/{{params\.mainTitle}}/g, mainTitle)
            .replace(/{{params\.mainIntro}}/g, mainIntro)
            .replace(/{{params\.orderStatus}}/g, statusText)
            .replace(/{{params\.orderId}}/g, orderId)
            .replace(/{{params\.orderDate}}/g, new Date().toLocaleDateString())
            .replace(/{{params\.orderTableRows}}/g, generateTableRows(items))
            .replace(/{{params\.totalPrice}}/g, formatPrice(totalCents))
            .replace(/{{params\.closeMessage}}/g, closeMsg)
            .replace(/{{contact\.EMAIL}}/g, buyerEmail);

        // STEP 4: Send Emails
        const subject = isStatusUpdate 
            ? (languageCode === 'es' ? `Actualización de Pedido #${orderId.substring(0,8)}` : `Order Update #${orderId.substring(0,8)}`)
            : (languageCode === 'es' ? "Confirmación de Pedido - autoInx" : "Order Confirmation - autoInx");

        const mailOptions = {
            from: '"autoInx Support" <noreply@autoinx.com>',
            to: buyerEmail,
            subject: subject,
            html: template
        };

        await transporter.sendMail(mailOptions);
        
        // Internal log email
        if (!isStatusUpdate) {
            await transporter.sendMail({ 
                ...mailOptions, 
                to: "orders@autoinx.com", 
                subject: `[NEW ORDER] #${orderId.substring(0,8)}` 
            });
        }

        return {
            statusCode: 200,
            body: JSON.stringify({ message: isStatusUpdate ? "Status update sent." : "New order processed.", orderId })
        };

    } catch (error) {
        console.error("Function Error:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "Email failure", details: error.message })
        };
    }
};
