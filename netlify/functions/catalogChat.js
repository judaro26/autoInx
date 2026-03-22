/**
 * catalogChat.js — Netlify serverless function
 * Powers the AI parts recommendation chat widget on the storefront.
 * Uses claude-haiku (fastest + cheapest) with the live product catalog as context.
 */
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = (products, storeName, isBusinessHours) => `You are a friendly and bilingual auto parts advisor for ${storeName}, a retailer based in the East Bay, California.

LANGUAGE: Always respond in the same language the customer writes in. If they write in Spanish, reply fully in Spanish. If English, reply in English. You are equally fluent in both.

CURRENT INVENTORY (use ONLY these products):
${products}

RESPONSE FORMAT — you MUST always reply with valid JSON only, no markdown, no extra text:
{
  "reply": "Your conversational message to the customer (2-4 sentences)",
  "recommendations": ["SKU1", "SKU2"]
}

- "reply": helpful message in the customer's language
- "recommendations": array of SKU strings for products you recommend (max 3). Empty array [] if none apply.

CONTACT:
${isBusinessHours
    ? '- If customer needs human help: tell them to tap "Chat with an agent" at the bottom of this chat window.'
    : '- We are AFTER HOURS. If customer needs human help: tell them to email support@autoinx.com and we will respond next business day.'}

RULES:
- Only recommend products from the inventory above. Never invent SKUs or prices.
- Match vehicle year/make/model to product descriptions when possible.
- If no match found, say so honestly and suggest contacting us.
- Keep "reply" concise: 2-4 sentences max.
- Always return valid JSON. No backticks, no markdown.`;

exports.handler = async function (event) {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    let body;
    try { body = JSON.parse(event.body); }
    catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

    const { messages, products = [], storeName = 'AutoInx', isBusinessHours = true } = body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return { statusCode: 400, body: JSON.stringify({ error: 'messages array is required' }) };
    }

    const safeMessages = messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({ role: m.role, content: String(m.content).slice(0, 1000) }))
        .slice(-10);

    if (!safeMessages.length || safeMessages[safeMessages.length - 1].role !== 'user') {
        return { statusCode: 400, body: JSON.stringify({ error: 'Last message must be from user' }) };
    }

    // Compact product list — include id so we can match back
    const productContext = products
        .slice(0, 150)
        .map(p => `SKU:${p.sku || p.id} | ${p.name} | $${p.price}${p.description ? ' | ' + p.description.slice(0, 100) : ''}`)
        .join('\n');

    try {
        const response = await client.messages.create({
            model:      'claude-haiku-4-5-20251001',
            max_tokens: 500,
            system:     SYSTEM_PROMPT(productContext || 'No products available.', storeName, isBusinessHours),
            messages:   safeMessages,
        });

        const raw = response.content?.[0]?.text || '{}';

        // Parse structured response
        let parsed;
        try {
            // Strip any accidental markdown fences
            const clean = raw.replace(/```json|```/g, '').trim();
            parsed = JSON.parse(clean);
        } catch {
            // Fallback: treat entire response as plain text reply
            parsed = { reply: raw, recommendations: [] };
        }

        const reply           = parsed.reply           || 'Sorry, I could not generate a response.';
        const recommendations = Array.isArray(parsed.recommendations) ? parsed.recommendations.slice(0, 3) : [];

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reply, recommendations }),
        };
    } catch (err) {
        console.error('catalogChat error:', err);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Chat service unavailable. Please try again later.' }),
        };
    }
};
