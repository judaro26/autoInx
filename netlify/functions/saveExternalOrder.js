const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    })
  });
}

const db = admin.firestore();

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: ''
    };
  }

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return {
        statusCode: 401,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Authorization required' })
      };
    }

    const idToken = authHeader.split('Bearer ')[1];
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    
    if (!decodedToken.admin) {
      return {
        statusCode: 403,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Admin access required' })
      };
    }

    const orderData = JSON.parse(event.body);
    
    // Validate required fields
    if (!orderData.platform || !orderData.externalOrderId || !orderData.customerName || 
        !orderData.orderDate || !orderData.product || !orderData.status) {
      return {
        statusCode: 400,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Missing required fields' })
      };
    }

    const ordersCollection = db.collection('admin').doc('externalOrders').collection('orders');
    
    const dataToSave = {
      platform: orderData.platform,
      externalOrderId: orderData.externalOrderId,
      customerName: orderData.customerName,
      orderDate: orderData.orderDate,
      product: orderData.product,
      status: orderData.status,
      amount: orderData.amount || null,
      trackingNumber: orderData.trackingNumber || null,
      notes: orderData.notes || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    let orderId;
    
    if (orderData.id) {
      // Update existing order
      await ordersCollection.doc(orderData.id).update(dataToSave);
      orderId = orderData.id;
    } else {
      // Create new order
      dataToSave.createdAt = admin.firestore.FieldValue.serverTimestamp();
      const docRef = await ordersCollection.add(dataToSave);
      orderId = docRef.id;
    }

    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ 
        success: true, 
        orderId,
        message: orderData.id ? 'Order updated' : 'Order created'
      })
    };

  } catch (error) {
    console.error('Error saving external order:', error);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Failed to save order', details: error.message })
    };
  }
};
