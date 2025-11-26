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
const SEND_EMAIL_FUNCTION_URL = `${SITE_URL}/.netlify/functions/send-email`;
const ORDERS_COLLECTION = process.env.ORDERS_COLLECTION_PATH || 'artifacts/default-app-id/public/data/orders';

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    // --- 1. Security Check: Validate Admin Token ---
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
        totalCents, // This MUST be present and non-zero
        buyerName, // This MUST be present
        buyerPhone, 
        deliveryAddress, // This MUST be present
        notes 
    } = orderDetails;
    
    if (!buyerEmail || !items || items.length === 0 || !totalCents || !buyerName || !deliveryAddress) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing required order fields: email, items, total, name, or address.' }) };
    }

    let orderRef = null;

    try {
        // 2. Prepare the order record for Firestore
        const orderData = {
            buyerEmail,
            buyerName,
            buyerPhone: buyerPhone || null,
            deliveryAddress,
            notes: notes || null,
            items,
            totalCents,
            status: 'Manually Created',
            createdByAdmin: decodedToken.email,
            timestamp: new Date().toISOString(),
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        // 3. Save the order to Firestore
        orderRef = await db.collection(ADMIN_ORDERS_COLLECTION).add(orderData);
        const orderId = orderRef.id;

        // 4. Call Netlify Function to send email
        const emailPayload = { 
            ...orderDetails, 
            orderId: orderId,
            timestamp: orderData.timestamp
        };
        
        const emailResponse = await fetch(SEND_EMAIL_FUNCTION_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(emailPayload)
        });

        if (!emailResponse.ok) {
            const emailErrorText = await emailResponse.text();
            console.error(`Email function failed for order ${orderId}: ${emailErrorText}`);
            // Update Firestore with email status failure (but don't fail the whole function)
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
        
        // If an order was partially created, mark it as failed
        if (orderRef) {
            await orderRef.update({ status: 'Creation Failed', failureDetails: error.message });
        }

        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to create order', details: error.message }),
        };
    }
};
