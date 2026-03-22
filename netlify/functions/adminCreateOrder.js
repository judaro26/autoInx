const admin = require('firebase-admin');
const fetch = require('node-fetch');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
    }),
  });
}

const db = admin.firestore();
const SITE_URL          = process.env.URL || 'https://autoinx-placeholder.netlify.app';
const ORDERS_COLLECTION = process.env.ORDERS_COLLECTION_PATH || 'artifacts/default-app-id/public/data/orders';

function sanitizeString(str) {
    if (!str) return '';
    return String(str).replace(/</g, '&lt;').replace(/>/g, '&gt;').trim();
}

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    // ── Auth ────────────────────────────────────────────────────────────────────
    const authHeader = event.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Authorization token required.' }) };
    }
    let decodedToken;
    try {
        decodedToken = await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1]);
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired token.' }) };
    }
    if (decodedToken.admin !== true) {
        return { statusCode: 403, body: JSON.stringify({ error: 'Admin privileges required.' }) };
    }

    // ── Parse body ──────────────────────────────────────────────────────────────
    let orderDetails;
    try { orderDetails = JSON.parse(event.body); }
    catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

    const {
        buyerEmail, buyerName, buyerPhone, deliveryAddress,
        items, notes, geolocation,
        // Financial breakdown from admin panel
        subtotalCents, shippingCents = 0, taxCents = 0,
        discountCents = 0, totalCents,
        discount, shippingDetails, taxDetails,
        // Local pickup
        isLocalPickup = false,
        // Other
        language, communicationLang,
        adminNotes, notificationPreferences,
        whatsappConsent, smsConsent,
    } = orderDetails;

    // ── Validation ───────────────────────────────────────────────────────────────
    if (!buyerEmail || typeof buyerEmail !== 'string' ||
        !items || !Array.isArray(items) || items.length === 0 ||
        !buyerName || typeof buyerName !== 'string') {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields: email, name, items.' }) };
    }

    // For pickup orders, delivery address is optional (replaced by pickup address)
    if (!isLocalPickup && (!deliveryAddress || typeof deliveryAddress !== 'string')) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Delivery address is required for non-pickup orders.' }) };
    }

    // ── Item validation & subtotal calculation ──────────────────────────────────
    let calculatedSubtotal = 0;
    const validatedItems = items.map(item => {
        const qty   = Number.isInteger(item.quantity) && item.quantity > 0 ? item.quantity : 0;
        const price = typeof item.price === 'number' && item.price >= 0 ? item.price : 0;
        if (!qty || !price) { console.warn('Skipping invalid item:', item); return null; }
        calculatedSubtotal += qty * price;
        return {
            id:       sanitizeString(item.id),
            name:     sanitizeString(item.name),
            sku:      sanitizeString(item.sku),
            price,
            quantity: qty,
        };
    }).filter(Boolean);

    if (validatedItems.length === 0) {
        return { statusCode: 400, body: JSON.stringify({ error: 'No valid items in order.' }) };
    }

    // ── Price integrity: verify ITEM subtotal only ───────────────────────────────
    // The old code compared calculatedSubtotal (items only) vs totalCents (items +
    // shipping + tax - discount), which always fails when shipping/tax/discount exist.
    // Now we only verify item prices; shipping/tax/discount are admin-controlled.
    if (subtotalCents != null && Math.abs(calculatedSubtotal - subtotalCents) > 1) {
        return { statusCode: 400, body: JSON.stringify({
            error: `Price integrity failure. Item subtotal mismatch: calculated ${calculatedSubtotal}, provided ${subtotalCents}.`
        })};
    }

    // Recompute grand total server-side
    const finalSubtotal = calculatedSubtotal;
    const finalDiscount = typeof discountCents === 'number' ? discountCents : 0;
    const finalShipping = typeof shippingCents === 'number' ? (isLocalPickup ? 0 : shippingCents) : 0;
    const finalTax      = typeof taxCents      === 'number' ? taxCents      : 0;
    const finalTotal    = Math.max(0, finalSubtotal - finalDiscount + finalShipping + finalTax);

    if (totalCents != null && Math.abs(finalTotal - totalCents) > 2) {
        console.warn(`Grand total mismatch — computed ${finalTotal}, received ${totalCents}. Using computed.`);
    }

    let finalGeolocation = null;
    if (geolocation?.lat != null && geolocation?.lng != null) {
        finalGeolocation = { lat: geolocation.lat, lng: geolocation.lng };
    }

    // ── Build Firestore document ─────────────────────────────────────────────────
    const PICKUP_ADDRESS = '25451 Clawiter Rd, Hayward, CA 94545';

    const orderData = {
        buyerEmail:            buyerEmail.trim(),
        buyerName:             sanitizeString(buyerName),
        buyerPhone:            buyerPhone || null,
        deliveryAddress:       isLocalPickup ? PICKUP_ADDRESS : sanitizeString(deliveryAddress),
        isLocalPickup:         !!isLocalPickup,
        notes:                 sanitizeString(notes),
        adminNotes:            sanitizeString(adminNotes),
        items:                 validatedItems,
        subtotalCents:         finalSubtotal,
        shippingCents:         finalShipping,
        taxCents:              finalTax,
        discountCents:         finalDiscount,
        totalCents:            finalTotal,
        discount:              discount || null,
        shippingDetails:       isLocalPickup ? { provider: 'Local Pickup', amount: 0 } : (shippingDetails || null),
        taxDetails:            taxDetails || null,
        geolocation:           finalGeolocation,
        notificationPreferences: notificationPreferences || { email: true, whatsapp: !!whatsappConsent, sms: !!smsConsent },
        language:              language || communicationLang || 'en',
        communicationLang:     language || communicationLang || 'en',
        status:                'Manually Created',
        createdByAdmin:        decodedToken.email,
        timestamp:             new Date().toISOString(),
        createdAt:             admin.firestore.FieldValue.serverTimestamp(),
    };

    let orderRef = null;
    try {
        orderRef = await db.collection(ORDERS_COLLECTION).add(orderData);
        const orderId = orderRef.id;

        // ── Send confirmation email ────────────────────────────────────────────
        const emailPayload = {
            ...orderDetails, ...orderData,
            orderId,
            timestamp:        orderData.timestamp,
            communicationLang: orderData.communicationLang,
        };
        const emailRes = await fetch(`${SITE_URL}/.netlify/functions/sendOrderConfirmation`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(emailPayload),
        });
        await orderRef.update({ emailStatus: emailRes.ok ? 'Sent' : 'Failed' });
        if (!emailRes.ok) console.error(`Email failed for order ${orderId}:`, await emailRes.text());

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'Order created successfully.', orderId }),
        };
    } catch (error) {
        console.error('Error creating order:', error);
        if (orderRef) await orderRef.update({ status: 'Creation Failed', failureDetails: error.message }).catch(() => {});
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to create order', details: error.message }),
        };
    }
};
