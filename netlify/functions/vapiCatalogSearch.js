// netlify/functions/vapiCatalogSearch.js
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

const safeJsonParse = (s) => {
  try { return { ok: true, value: JSON.parse(s) }; }
  catch (e) { return { ok: false, error: e?.message || String(e) }; }
};

const respondTool = (headers, toolCallId, resultObj) => ({
  statusCode: 200,
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    results: [{ toolCallId: toolCallId || null, result: resultObj }],
  }),
});

exports.handler = async (event) => {
  const requestId =
    event.headers?.['x-nf-request-id'] ||
    event.headers?.['x-request-id'] ||
    `local-${Date.now()}`;

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  // Log raw request (truncate to avoid huge logs)
  const rawBody = event.body || '';
  console.log('[vapiCatalogSearch] requestId=', requestId);
  console.log('[vapiCatalogSearch] method=', event.httpMethod);
  console.log('[vapiCatalogSearch] content-type=', event.headers?.['content-type']);
  console.log('[vapiCatalogSearch] rawBody(trunc)=', rawBody.slice(0, 2000));

  if (event.httpMethod !== 'POST') {
    return respondTool(headers, null, {
      success: false,
      error: 'Method Not Allowed',
      debug: { requestId },
    });
  }

  const parsedBody = safeJsonParse(rawBody || '{}');
  if (!parsedBody.ok) {
    console.log('[vapiCatalogSearch] body JSON parse failed:', parsedBody.error);
    return respondTool(headers, null, {
      success: false,
      error: 'Invalid JSON body',
      debug: { requestId, parseError: parsedBody.error },
    });
  }

  const body = parsedBody.value;

  // Extract toolCallId + args in multiple possible shapes
  const toolCallId =
    body.toolCallId ||
    body.toolCallID ||
    body.tool_call_id ||
    body?.message?.toolCallList?.[0]?.id ||
    null;

  let args = body;
  const argString = body?.message?.toolCallList?.[0]?.function?.arguments;
  if (typeof argString === 'string') {
    const parsedArgs = safeJsonParse(argString);
    if (parsedArgs.ok) args = parsedArgs.value;
    else {
      console.log('[vapiCatalogSearch] tool arguments JSON parse failed:', parsedArgs.error);
      return respondTool(headers, toolCallId, {
        success: false,
        error: 'Invalid tool arguments JSON',
        debug: { requestId, toolCallId, parseError: parsedArgs.error, argString: argString.slice(0, 500) },
      });
    }
  }

  const action = args?.action;
  const make = args?.make;
  const model = args?.model;
  const year = args?.year;
  const query = args?.query;

  console.log('[vapiCatalogSearch] toolCallId=', toolCallId);
  console.log('[vapiCatalogSearch] args=', JSON.stringify({ action, make, model, year, query }));

  try {
    if (action !== 'search' && action !== 'searchByVehicle') {
      return respondTool(headers, toolCallId, {
        success: false,
        error: 'Invalid action',
        received: action,
        debug: { requestId, toolCallId },
      });
    }

    const [itemsSnapshot, catalogsSnapshot] = await Promise.all([
      db.collection(`artifacts/${APP_ID}/public/data/items`).get(),
      db.collection(`artifacts/${APP_ID}/public/data/catalogs`).get(),
    ]);

    const catalogs = {};
    catalogsSnapshot.forEach((doc) => (catalogs[doc.id] = doc.data().name));

    const term = String(query || '').toLowerCase();
    const makeLc = make ? String(make).toLowerCase() : null;
    const modelLc = model ? String(model).toLowerCase() : null;
    const yearStr = year ? String(year) : null;

    let products = [];

    itemsSnapshot.forEach((doc) => {
      const data = doc.data();
      const desc = String(data.description || '').toLowerCase();
      const name = String(data.name || '').toLowerCase();

      const baseProduct = {
        id: doc.id,
        name: data.name,
        description: data.description, // consider truncating later for tokens
        price: `$${(data.price / 100).toFixed(2)}`,
        category: catalogs[data.catalogId] || 'Uncategorized',
        stock: data.stock || 0,
        sku: data.sku,
        imageUrl: data.imageUrl,
      };

      if (action === 'searchByVehicle') {
        const makeMatch = !makeLc || desc.includes(makeLc);
        const modelMatch = !modelLc || desc.includes(modelLc);
        const yearMatch = !yearStr || desc.includes(yearStr);
        const queryMatch = !term || name.includes(term) || desc.includes(term);

        if (makeMatch && modelMatch && yearMatch && queryMatch) products.push(baseProduct);
      } else {
        if (!term) return;
        if (name.includes(term) || desc.includes(term)) products.push(baseProduct);
      }
    });

    products = products.slice(0, 5);

    console.log('[vapiCatalogSearch] matched=', products.length);

    return respondTool(headers, toolCallId, {
      success: true,
      count: products.length,
      products,
      debug: { requestId, toolCallId },
    });
  } catch (err) {
    console.log('[vapiCatalogSearch] ERROR:', err);
    return respondTool(headers, toolCallId, {
      success: false,
      error: 'Catalog service error',
      details: err?.message || String(err),
      debug: { requestId, toolCallId },
    });
  }
};