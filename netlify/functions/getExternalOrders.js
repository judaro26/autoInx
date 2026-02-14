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
        'Access-Control-Allow-Methods': 'GET, OPTIONS'
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

    const ordersSnapshot = await db.collection('admin').doc('externalOrders').collection('orders').get();
    
    const orders = ordersSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    // Sort by date descending
    orders.sort((a, b) => new Date(b.orderDate) - new Date(a.orderDate));

    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ orders })
    };

  } catch (error) {
    console.error('Error fetching external orders:', error);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Failed to fetch orders', details: error.message })
    };
  }
};
