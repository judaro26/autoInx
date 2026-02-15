const admin = require('firebase-admin');

// Initialize Firebase Admin
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
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Content-Type': 'application/json'
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 204, headers, body: '' };
    }

    try {
        const { action, make, model, year, query } = JSON.parse(event.body || '{}');

        // Get all products
        if (action === 'search' || action === 'searchByVehicle') {
            const itemsSnapshot = await db
                .collection(`artifacts/${APP_ID}/public/data/items`)
                .get();

            const catalogsSnapshot = await db
                .collection(`artifacts/${APP_ID}/public/data/catalogs`)
                .get();

            // Build category map
            const catalogs = {};
            catalogsSnapshot.forEach(doc => {
                catalogs[doc.id] = doc.data().name;
            });

            let products = [];
            
            itemsSnapshot.forEach(doc => {
                const data = doc.data();
                const desc = data.description?.toLowerCase() || '';
                
                // If searching by vehicle
                if (make || model || year) {
                    const makeMatch = !make || desc.includes(make.toLowerCase());
                    const modelMatch = !model || desc.includes(model.toLowerCase());
                    const yearMatch = !year || desc.includes(year.toString());
                    
                    if (makeMatch && modelMatch && yearMatch) {
                        products.push({
                            id: doc.id,
                            name: data.name,
                            description: data.description,
                            price: `$${(data.price / 100).toFixed(2)}`,
                            category: catalogs[data.catalogId] || 'Uncategorized',
                            stock: data.stock || 0,
                            sku: data.sku,
                            imageUrl: data.imageUrl
                        });
                    }
                } else if (query) {
                    // General search by product name or description
                    const searchTerm = query.toLowerCase();
                    if (data.name.toLowerCase().includes(searchTerm) || desc.includes(searchTerm)) {
                        products.push({
                            id: doc.id,
                            name: data.name,
                            description: data.description,
                            price: `$${(data.price / 100).toFixed(2)}`,
                            category: catalogs[data.catalogId] || 'Uncategorized',
                            stock: data.stock || 0,
                            sku: data.sku,
                            imageUrl: data.imageUrl
                        });
                    }
                } else {
                    // Return all products
                    products.push({
                        id: doc.id,
                        name: data.name,
                        description: data.description?.substring(0, 150) + '...',
                        price: `$${(data.price / 100).toFixed(2)}`,
                        category: catalogs[data.catalogId] || 'Uncategorized',
                        stock: data.stock || 0,
                        sku: data.sku,
                        imageUrl: data.imageUrl
                    });
                }
            });

            // Limit results
            products = products.slice(0, 5);

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ 
                    success: true,
                    count: products.length,
                    products 
                })
            };
        }

        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ success: false, error: 'Invalid action' })
        };

    } catch (error) {
        console.error('Chatbot API Error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ success: false, error: error.message })
        };
    }
};
