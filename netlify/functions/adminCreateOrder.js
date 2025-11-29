/**
 * Netlify Function (Admin Only) to create an order manually.
 * It uses the Firebase Admin SDK to save the order and then calls the send-email function.
 */
const admin = require('firebase-admin');
const fetch = require('node-fetch');

// Ensure Firebase Admin is initialized once
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
    }),
  });
}

const db = admin.firestore();
const SITE_URL = process.env.URL || 'https://autoinx-placeholder.netlify.app'; 
// Use the correct function path for the email service
const ORDERS_COLLECTION = process.env.ORDERS_COLLECTION_PATH || 'artifacts/default-app-id/public/data/orders';

// Helper function to sanitize strings and remove HTML/script tags
function sanitizeString(str) {
    if (!str) return '';
    // Simple filter to prevent XSS (Cross-Site Scripting) injection
    return String(str).replace(/</g, "&lt;").replace(/>/g, "&gt;").trim();
}

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    // --- 1. Security Check: Validate Admin Token (CRITICAL) ---
    const authHeader = event.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Authorization token required.' }) };
    }

    const idToken = authHeader.split('Bearer ')[1];
    let decodedToken;
    try {
        decodedToken = await admin.auth().verifyIdToken(idToken);
    } catch (e) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired token.' }) };
    }

    if (decodedToken.admin !== true) {
        return { statusCode: 403, body: JSON.stringify({ error: 'Access denied: Admin privileges required.' }) };
    }
    // --- End Security Check ---

    let orderDetails;
    try {
        orderDetails = JSON.parse(event.body);
    } catch (error) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }

    const { 
        buyerEmail, 
        items, 
        totalCents,
        buyerName,
        buyerPhone, 
        deliveryAddress,
        notes,
        geolocation 
    } = orderDetails;
    
    // --- 2. Enhanced Input Validation and Sanitization ---
    
    // Check for required fields and basic types
    if (!buyerEmail || typeof buyerEmail !== 'string' || 
        !items || !Array.isArray(items) || items.length === 0 || 
        !totalCents || typeof totalCents !== 'number' || totalCents <= 0 || 
        !buyerName || typeof buyerName !== 'string' || 
        !deliveryAddress || typeof deliveryAddress !== 'string') {
        
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing or invalid required order fields: email, items (array), totalCents (number > 0), name, or address.' }) };
    }
    
    // Sanitize user-provided string inputs
    const sanitizedName = sanitizeString(buyerName);
    const sanitizedAddress = sanitizeString(deliveryAddress);
    const sanitizedNotes = sanitizeString(notes);
    
    // Validate item structure and calculate total for price integrity check
    let calculatedTotalCents = 0;
    
    const validatedItems = items.map(item => {
        const quantity = item.quantity && typeof item.quantity === 'number' && item.quantity > 0 ? Math.floor(item.quantity) : 0;
        const price = item.price && typeof item.price === 'number' && item.price >= 0 ? item.price : 0;
        
        if (quantity === 0 || price === 0) {
            console.warn("Invalid item quantity or price detected and ignored.");
            return null; 
        }
        
        calculatedTotalCents += quantity * price;
        
        return {
            id: sanitizeString(item.id),
            name: sanitizeString(item.name),
            sku: sanitizeString(item.sku),
            price: price,
            quantity: quantity
        };
    }).filter(item => item !== null);

    // Price Integrity Check: Ensure client's total matches server's calculation
    if (Math.abs(calculatedTotalCents - totalCents) > 1) { 
        return { statusCode: 400, body: JSON.stringify({ error: `Price integrity failure. Calculated total (${calculatedTotalCents}) does not match provided total (${totalCents}).` }) };
    }
    
    // Validate geolocation if present
    let finalGeolocation = null;
    if (geolocation && typeof geolocation.lat === 'number' && typeof geolocation.lng === 'number') {
        finalGeolocation = { lat: geolocation.lat, lng: geolocation.lng };
    }
    
    // --- End Enhanced Input Validation and Sanitization ---

    let orderRef = null;

    try {
        // 3. Prepare the order record for Firestore (using sanitized/validated data)
        const orderData = {
            buyerEmail: buyerEmail.trim(), 
            buyerName: sanitizedName,
            buyerPhone: buyerPhone || null,
            deliveryAddress: sanitizedAddress,
            notes: sanitizedNotes,
            items: validatedItems,
            totalCents: calculatedTotalCents,
            geolocation: finalGeolocation,
            status: 'Manually Created',
            createdByAdmin: decodedToken.email,
            timestamp: new Date().toISOString(),
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        // 4. Save the order to Firestore
        orderRef = await db.collection(ORDERS_COLLECTION).add(orderData); 
        const orderId = orderRef.id;

        // 5. Call Netlify Function to send email
        const emailPayload = { 
            ...orderDetails, 
            orderId: orderId,
            timestamp: orderData.timestamp
        };
        
        const emailResponse = await fetch(`${SITE_URL}/.netlify/functions/sendOrderConfirmation`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(emailPayload)
        });

        if (!emailResponse.ok) {
            const emailErrorText = await emailResponse.text();
            console.error(`Email function failed for order ${orderId}: ${emailErrorText}`);
            await orderRef.update({ emailStatus: 'Failed' });
        } else {
            await orderRef.update({ emailStatus: 'Sent' });
        }

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                message: 'Order created and email initiated successfully.', 
                orderId: orderId 
            }),
        };

    } catch (error) {
        console.error('Error creating order:', error);
        
        if (orderRef) {
            await orderRef.update({ status: 'Creation Failed', failureDetails: error.message });
        }

        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to create order', details: error.message }),
        };
    }
};
