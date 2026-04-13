// netlify/functions/vapiCatalogSearch.js
// Wraps getChatbotProducts-style search in Vapi "tool-calls" response format.

const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

const db = admin.firestore();
const APP_ID = process.env.APP_ID || 'default-app-id';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method Not Allowed' }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  // Vapi tool-calls payload includes toolCallId and tool call args.
  // We support both shapes:
  // - { toolCallId, action, make, model, year, query }
  // - { message: { toolCallList: [{ id, function: { arguments } }] } } (defensive)
  const toolCallId =
    body.toolCallId ||
    body.toolCallID ||
    body.tool_call_id ||
    body?.message?.toolCallList?.[0]?.id ||
    null;

  const args =
    body?.message?.toolCallList?.[0]?.function?.arguments
      ? (() => {
          try { return JSON.parse(body.message.toolCallList[0].function.arguments); }
          catch { return {}; }
        })()
      : body;

  const { action, make, model, year, query } = args || {};

  try {
    if (action !== 'search' && action !== 'searchByVehicle') {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          results: [
            {
              toolCallId,
              result: { success: false, error: 'Invalid action', received: action },
            },
          ],
        }),
      };
    }

    const itemsSnapshot = await db
      .collection(`artifacts/${APP_ID}/public/data/items`)
      .get();

    const catalogsSnapshot = await db
      .collection(`artifacts/${APP_ID}/public/data/catalogs`)
      .get();

    const catalogs = {};
    catalogsSnapshot.forEach((doc) => {
      catalogs[doc.id] = doc.data().name;
    });

    let products = [];

    itemsSnapshot.forEach((doc) => {
      const data = doc.data();
      const desc = (data.description || '').toLowerCase();
      const name = (data.name || '').toLowerCase();

      if (action === 'searchByVehicle') {
        const makeMatch = !make || desc.includes(String(make).toLowerCase());
        const modelMatch = !model || desc.includes(String(model).toLowerCase());
        const yearMatch = !year || desc.includes(String(year));
        const queryMatch = !query || name.includes(String(query).toLowerCase()) || desc.includes(String(query).toLowerCase());

        if (makeMatch && modelMatch && yearMatch && queryMatch) {
          products.push({
            id: doc.id,
            name: data.name,
            description: data.description,
            price: `$${(data.price / 100).toFixed(2)}`,
            category: catalogs[data.catalogId] || 'Uncategorized',
            stock: data.stock || 0,
            sku: data.sku,
            imageUrl: data.imageUrl,
          });
        }
      } else {
        // action === 'search'
        const term = String(query || '').toLowerCase();
        if (!term) return;
        if (name.includes(term) || desc.includes(term)) {
          products.push({
            id: doc.id,
            name: data.name,
            description: data.description,
            price: `$${(data.price / 100).toFixed(2)}`,
            category: catalogs[data.catalogId] || 'Uncategorized',
            stock: data.stock || 0,
            sku: data.sku,
            imageUrl: data.imageUrl,
          });
        }
      }
    });

    products = products.slice(0, 5);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        results: [
          {
            toolCallId,
            result: {
              success: true,
              count: products.length,
              products,
            },
          },
        ],
      }),
    };
  } catch (err) {
    console.error('vapiCatalogSearch error:', err);
    return {
      statusCode: 200, // return 200 so Vapi still gets a tool result envelope
      headers,
      body: JSON.stringify({
        results: [
          {
            toolCallId,
            result: { success: false, error: 'Catalog service error', details: err.message },
          },
        ],
      }),
    };
  }
};