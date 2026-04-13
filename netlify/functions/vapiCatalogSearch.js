// netlify/functions/vapiCatalogSearch.js
// Vapi tool-call wrapper for AutoInx catalog search (Firestore).
// Handles Vapi payload shapes where function.arguments is an OBJECT (not a JSON string)
// and always returns the Vapi tool result envelope: { results: [{ toolCallId, result }] }.

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
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
};

const respondTool = (headers, toolCallId, resultObj) => {
  return {
    statusCode: 200, // keep 200 so Vapi receives a tool result (even on internal errors)
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      results: [{ toolCallId: toolCallId || null, result: resultObj }],
    }),
  };
};

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

  // Vapi commonly sends: body.message.toolCallList[0].id and ...function.arguments (OBJECT)
  const toolCallId =
    body?.message?.toolCallList?.[0]?.id ||
    body?.message?.toolCalls?.[0]?.id ||
    body.toolCallId ||
    body.toolCallID ||
    body.tool_call_id ||
    null;

  // Extract arguments; support OBJECT or JSON string.
  const argCandidate =
    body?.message?.toolCallList?.[0]?.function?.arguments ??
    body?.message?.toolCalls?.[0]?.function?.arguments ??
    body?.message?.toolCallList?.[0]?.function?.args ??
    body?.message?.toolCalls?.[0]?.function?.args ??
    null;

  let args = {};
  if (argCandidate && typeof argCandidate === 'object') {
    args = argCandidate;
  } else if (typeof argCandidate === 'string') {
    const parsedArgs = safeJsonParse(argCandidate);
    if (parsedArgs.ok) args = parsedArgs.value;
    else {
      console.log('[vapiCatalogSearch] tool arguments JSON parse failed:', parsedArgs.error);
      return respondTool(headers, toolCallId, {
        success: false,
        error: 'Invalid tool arguments JSON',
        debug: {
          requestId,
          toolCallId,
          parseError: parsedArgs.error,
          argString: argCandidate.slice(0, 500),
        },
      });
    }
  } else {
    // Fallback: some callers may send args at top-level
    args = body || {};
  }

  const { action, make, model, year, query } = args || {};

  console.log('[vapiCatalogSearch] toolCallId=', toolCallId);
  console.log(
    '[vapiCatalogSearch] args=',
    JSON.stringify({ action, make, model, year, query })
  );

  try {
    if (action !== 'search' && action !== 'searchByVehicle') {
      return respondTool(headers, toolCallId, {
        success: false,
        error: 'Invalid or missing action',
        received: action,
        debug: {
          requestId,
          toolCallId,
          receivedArgsType: typeof argCandidate,
          receivedArgs: argCandidate,
        },
      });
    }

    const [itemsSnapshot, catalogsSnapshot] = await Promise.all([
      db.collection(`artifacts/${APP_ID}/public/data/items`).get(),
      db.collection(`artifacts/${APP_ID}/public/data/catalogs`).get(),
    ]);

    const catalogs = {};
    catalogsSnapshot.forEach((doc) => {
      catalogs[doc.id] = doc.data().name;
    });

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
        description: data.description,
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

        if (makeMatch && modelMatch && yearMatch && queryMatch) {
          products.push(baseProduct);
        }
      } else {
        // action === 'search'
        if (!term) return;
        if (name.includes(term) || desc.includes(term)) {
          products.push(baseProduct);
        }
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