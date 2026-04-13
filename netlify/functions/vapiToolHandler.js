/**
 * Netlify Function: vapiToolHandler.js
 *
 * Purpose:
 * - Vapi sends tool calls in a webhook envelope like:
 *   { message: { type: "tool-calls", toolCallList: [ { id, function: { name, arguments } } ] } }
 * - Your existing sendContactEmail expects a plain JSON body:
 *   { name, email, subjectType, message, preferredLang, orderNumber? }
 *
 * This function unwraps the Vapi payload, forwards ONLY the arguments to sendContactEmail,
 * then returns the "results" envelope Vapi expects.
 */
exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const toolCalls =
    payload?.message?.toolCallList ||
    payload?.message?.toolCalls ||
    payload?.toolCallList ||
    payload?.toolCalls ||
    [];

  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: "No tool calls found" }) };
  }

  // Typically Vapi sends one tool call at a time
  const tc = toolCalls[0];
  const toolCallId = tc?.id;
  const args = tc?.function?.arguments;

  if (!toolCallId) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing toolCallId" }) };
  }
  if (!args || typeof args !== "object") {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing function arguments" }) };
  }

  try {
    const resp = await fetch("https://autoinx.com/.netlify/functions/sendContactEmail", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });

    const text = await resp.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }

    // Return success to Vapi even if sendContactEmail returns 4xx/5xx,
    // but include ok/status so the model can react if needed.
    return {
      statusCode: 200,
      body: JSON.stringify({
        results: [
          {
            toolCallId,
            result: {
              ok: resp.ok,
              status: resp.status,
              response: parsed,
            },
          },
        ],
      }),
    };
  } catch (err) {
    // Same: return 200 so Vapi receives a tool result payload, but mark it failed.
    return {
      statusCode: 200,
      body: JSON.stringify({
        results: [
          {
            toolCallId,
            result: {
              ok: false,
              status: 0,
              error: err?.message || String(err),
            },
          },
        ],
      }),
    };
  }
};