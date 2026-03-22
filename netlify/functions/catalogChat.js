/**
 * catalogChat.js — Netlify serverless function
 * Powers the AI parts recommendation chat widget on the storefront.
 * Uses claude-haiku (fastest + cheapest) with the live product catalog as context.
 */
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = (products, storeName) => `You are a friendly and knowledgeable auto parts advisor for ${storeName}, an automotive parts retailer based in the East Bay, California. Your job is to help customers find the right parts from the store's current inventory.

CURRENT INVENTORY:
${products}

GUIDELINES:
- Only recommend products that are in the inventory list above.
- Be specific: mention the product name, SKU, and price when recommending.
- If a customer describes their vehicle (year/make/model), cross-reference it with the product descriptions to find compatible parts.
- If no product matches, honestly say you don't currently carry that item and suggest they contact support@autoinx.com.
- Keep responses concise and helpful — 2–4 sentences max unless the customer asks for more detail.
- You can answer general automotive questions (e.g. "how often should I change my air filter?") even if the product isn't in stock.
- Do NOT make up products, prices, or SKUs. Only reference what's in the inventory.
- If asked about pricing, shipping, or returns, direct them to the store website or support@autoinx.com.
- Friendly, conversational tone. Not overly formal.`;

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    let body;
    try {
        body = JSON.parse(event.body);
    } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }

    const { messages, products = [], storeName = 'AutoInx' } = body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return { statusCode: 400, body: JSON.stringify({ error: 'messages array is required' }) };
    }

    // Sanitize messages — only allow user/assistant roles, text content only
    const safeMessages = messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({ role: m.role, content: String(m.content).slice(0, 1000) }))
        .slice(-10); // keep last 10 turns to stay within token budget

    if (safeMessages.length === 0 || safeMessages[safeMessages.length - 1].role !== 'user') {
        return { statusCode: 400, body: JSON.stringify({ error: 'Last message must be from user' }) };
    }

    // Build a compact product list for the system prompt (cap at 150 products to stay within tokens)
    const productContext = products
        .slice(0, 150)
        .map(p => `- ${p.name}${p.sku ? ` [SKU: ${p.sku}]` : ''} — $${p.price}${p.description ? ` | ${p.description.slice(0, 120)}` : ''}${p.stock != null ? ` | Stock: ${p.stock}` : ''}`)
        .join('\n');

    try {
        const response = await client.messages.create({
            model:      'claude-haiku-4-5-20251001',
            max_tokens: 400,
            system:     SYSTEM_PROMPT(productContext || 'No products available.', storeName),
            messages:   safeMessages,
        });

        const reply = response.content?.[0]?.text || "I'm sorry, I couldn't generate a response. Please try again.";

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reply }),
        };
    } catch (err) {
        console.error('catalogChat error:', err);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Chat service unavailable. Please try again later.' }),
        };
    }
};
