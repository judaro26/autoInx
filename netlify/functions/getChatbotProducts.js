const admin = require('firebase-admin');

// Initialize Firebase Admin (reuse from your other functions)
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
        })
    });
}

const db = admin.firestore();
const APP_ID = process.env.APP_ID || 'default-app-id';

exports.handler = async (event, context) => {
    // Set CORS headers
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Content-Type': 'application/json'
    };

    // Handle preflight
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 204, headers, body: '' };
    }

    try {
        const { action, query, itemId } = JSON.parse(event.body || '{}');

        // Action: Get all products
        if (action === 'getAllProducts') {
            const itemsSnapshot = await db
                .collection(`artifacts/${APP_ID}/public/data/items`)
                .get();

            const catalogsSnapshot = await db
                .collection(`artifacts/${APP_ID}/public/data/catalogs`)
                .get();

            const catalogs = {};
            catalogsSnapshot.forEach(doc => {
                catalogs[doc.id] = doc.data().name;
            });

            const products = itemsSnapshot.docs.map(doc => {
                const data = doc.data();
                return {
                    id: doc.id,
                    name: data.name,
                    description: data.description,
                    price: (data.price / 100).toFixed(2),
                    category: catalogs[data.catalogId] || 'Uncategorized',
                    stock: data.stock || 0,
                    sku: data.sku,
                    imageUrl: data.imageUrl,
                    compatibility: extractCompatibility(data.description)
                };
            });

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ products })
            };
        }

        // Action: Search products by vehicle
        if (action === 'searchByVehicle') {
            const { make, model, year } = JSON.parse(event.body).query;
            
            const itemsSnapshot = await db
                .collection(`artifacts/${APP_ID}/public/data/items`)
                .get();

            const matchingProducts = [];
            
            itemsSnapshot.forEach(doc => {
                const data = doc.data();
                const desc = data.description?.toLowerCase() || '';
                
                // Check if description contains the vehicle info
                const makeMatch = !make || desc.includes(make.toLowerCase());
                const modelMatch = !m
