/**
 * Netlify Function: packItems.js
 *
 * Uses Claude to determine the optimal box dimensions for a set of cart items,
 * minimising dimensional weight while physically fitting everything.
 *
 * Falls back to a deterministic first-fit-decreasing bin-packer if the AI
 * call fails or times out.
 *
 * Input (POST JSON):
 *   { items: [{ name, length, width, height, weight, quantity }] }
 *
 * Output:
 *   { length, width, height, weight, source: 'ai'|'algorithm', reasoning }
 */

const Anthropic = require('@anthropic-ai/sdk');

const HEADERS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': process.env.URL || 'https://autoinx.com',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

// ── Algorithmic fallback — proper 3D stacking ─────────────────────────────────
function algorithmicPack(items) {
    // Expand each cart entry into individual unit boxes, trying all 3 orientations
    // and picking the one with smallest bounding-box volume when stacked.
    const units = [];
    for (const item of items) {
        const qty = item.quantity || 1;
        const dims = [item.length, item.width, item.height].map(Number).sort((a, b) => b - a);
        // dims[0] = longest, dims[1] = mid, dims[2] = shortest
        for (let q = 0; q < qty; q++) {
            units.push({ l: dims[0], w: dims[1], h: dims[2], wt: Number(item.weight) });
        }
    }

    if (units.length === 0) return null;

    // Sort units by volume descending (largest first — FFD heuristic)
    units.sort((a, b) => (b.l * b.w * b.h) - (a.l * a.w * a.h));

    // Simple strip packing:
    // Keep the longest item's length fixed, stack all others by growing width then height.
    // This is optimal for long, thin items like wiperblades laid parallel.
    let boxL = units[0].l;
    let boxW = units[0].w;
    let boxH = units[0].h;
    let totalWeight = units[0].wt;

    for (let i = 1; i < units.length; i++) {
        const u = units[i];
        totalWeight += u.wt;

        // Try fitting this unit alongside previous items
        // Option A: extend width (items side by side)
        const optA_vol = boxL * (boxW + u.w) * Math.max(boxH, u.h);
        // Option B: extend height (items stacked)
        const optB_vol = boxL * Math.max(boxW, u.w) * (boxH + u.h);
        // Option C: the unit fits inside current box footprint already
        const fitsInside = u.l <= boxL && u.w <= boxW && u.h <= boxH;

        if (fitsInside) {
            // No need to grow the box; already fits (e.g. a small accessory)
            continue;
        } else if (optA_vol <= optB_vol) {
            boxW = boxW + u.w;
            boxH = Math.max(boxH, u.h);
        } else {
            boxW = Math.max(boxW, u.w);
            boxH = boxH + u.h;
        }
        // Length is always the max of longest items
        boxL = Math.max(boxL, u.l);
    }

    // Add 2" packaging padding on each dimension
    return {
        length: Math.ceil(boxL) + 2,
        width:  Math.ceil(boxW) + 2,
        height: Math.ceil(boxH) + 2,
        weight: Math.max(0.5, totalWeight),
    };
}

// ── Dimensional weight check ─────────────────────────────────────────────────
function dimWeight(l, w, h) {
    return (l * w * h) / 139; // UPS/FedEx divisor
}

exports.handler = async function(event) {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: HEADERS, body: '' };
    }
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    let items;
    try {
        ({ items } = JSON.parse(event.body));
        if (!Array.isArray(items) || items.length === 0) throw new Error('no items');
    } catch {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid request body' }) };
    }

    // ── 1. Try Claude first ───────────────────────────────────────────────────
    try {
        const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

        const itemList = items.map(i =>
            `- ${i.name} (qty: ${i.quantity}): ${i.length}"L × ${i.width}"W × ${i.height}"H, ${i.weight} lbs each`
        ).join('\n');

        const totalWeight = items.reduce((s, i) => s + (Number(i.weight) * (i.quantity || 1)), 0);

        const message = await client.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 300,
            messages: [{
                role: 'user',
                content: `You are a packaging expert. Given these items to ship together in ONE box, determine the smallest realistic box dimensions that fit all items efficiently. Consider how items naturally nest, stack, or pack together (e.g. flat items can lay side by side, long thin items can be bundled parallel).

Items:
${itemList}

Total weight: ${totalWeight.toFixed(2)} lbs

Rules:
- All items must physically fit
- Use real-world packing intuition (wiperblades lay flat and stack; small parts fit in gaps)
- Minimise dimensional weight (L × W × H ÷ 139) 
- Add 1–2 inches of padding on each side for protection
- Return ONLY valid JSON, no explanation outside the JSON

Return exactly:
{"length": <number>, "width": <number>, "height": <number>, "reasoning": "<one sentence>"}`
            }]
        });

        const raw = message.content[0]?.text?.trim() || '';
        // Strip any markdown fences just in case
        const jsonStr = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/,'').trim();
        const parsed  = JSON.parse(jsonStr);

        const { length, width, height, reasoning } = parsed;

        if (!length || !width || !height ||
            length < 1 || width < 1 || height < 1 ||
            length > 120 || width > 120 || height > 120) {
            throw new Error('AI returned out-of-range dimensions');
        }

        const aiDimWt = dimWeight(length, width, height);
        console.log(`📦 AI pack: ${length}×${width}×${height}" | dim wt ${aiDimWt.toFixed(1)} lbs | ${reasoning}`);

        // Sanity-check: if AI result is worse than algorithm by >20%, prefer algorithm
        const algo = algorithmicPack(items);
        if (algo) {
            const algoDimWt = dimWeight(algo.length, algo.width, algo.height);
            if (aiDimWt > algoDimWt * 1.2) {
                console.log(`📦 Algorithm better: ${algo.length}×${algo.width}×${algo.height}" (${algoDimWt.toFixed(1)} lbs dim wt)`);
                return {
                    statusCode: 200,
                    headers: HEADERS,
                    body: JSON.stringify({ ...algo, source: 'algorithm', reasoning: 'Algorithmic packing produced a smaller dimensional weight than AI suggestion' }),
                };
            }
        }

        return {
            statusCode: 200,
            headers: HEADERS,
            body: JSON.stringify({
                length: Math.round(length),
                width:  Math.round(width),
                height: Math.round(height),
                weight: Math.max(0.5, totalWeight),
                source: 'ai',
                reasoning,
            }),
        };

    } catch (aiErr) {
        console.warn('⚠️ AI packing failed, using algorithm:', aiErr.message);

        // ── 2. Algorithmic fallback ───────────────────────────────────────────
        const result = algorithmicPack(items);
        if (!result) {
            return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Could not pack items' }) };
        }

        const dw = dimWeight(result.length, result.width, result.height);
        console.log(`📦 Algorithm pack: ${result.length}×${result.width}×${result.height}" | dim wt ${dw.toFixed(1)} lbs`);

        return {
            statusCode: 200,
            headers: HEADERS,
            body: JSON.stringify({ ...result, source: 'algorithm', reasoning: 'Items packed algorithmically' }),
        };
    }
};
