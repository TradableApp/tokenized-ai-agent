/**
 * Direct Gemini `generateContent` calls, bypassing the ElizaOS runtime.
 *
 * Two jobs live here, both formerly served by an Ollama sidecar running gemma3:1b inside the
 * TEE (removed in CU-14ym9bve42k):
 *
 *   1. `classifyIntent` — the TRADABLE-vs-MARKET router that decides whether a prompt goes to
 *      the first-party Tradable assistant or to the ElizaOS/Brain path. Never throws: any
 *      failure routes to MARKET, exactly as the Ollama router did.
 *   2. `queryGeminiDirect` — the last-resort answer tier behind ElizaOS and ChainGPT. Throws on
 *      failure so the dispatcher records `none` and returns its outage message.
 *
 * Why not reuse the ElizaOS runtime's `useModel`? The ElizaOS path already fronts Gemini via
 * plugin-google-genai. When it throws, the cause is as likely to be the agent pipeline
 * (plugin-sql, MCP, memory/room handling) as Gemini itself. A plain HTTP call with no runtime in
 * between is a genuinely different failure domain, which is what a last-resort tier is for.
 *
 * Model ids come from the same env the google-genai plugin reads (`GOOGLE_SMALL_MODEL` /
 * `GOOGLE_LARGE_MODEL`), falling back to the bare `SMALL_MODEL` / `LARGE_MODEL` keys that the
 * env files define alongside them. Nothing is hard-coded here: test/modelLifecycle.test.js
 * guards the example env against retired ids, and that guard only works if this module follows
 * the env rather than pinning its own.
 */

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/** Low temperature for a classifier: we want the same label for the same question. */
const ROUTING_TEMPERATURE = 0.1;

/** Response schema the router asks Gemini to honour; the enum is the whole contract. */
const INTENT_SCHEMA = {
  type: "OBJECT",
  properties: { category: { type: "STRING", enum: ["TRADABLE", "ELIZAOS"] } },
  required: ["category"],
};

const ROUTING_INSTRUCTIONS = `Task: Categorize the user query into "TRADABLE" or "ELIZAOS".

Categories:
- TRADABLE: If the query is specifically about Tradable's app features, founders, pricing, or support.
- ELIZAOS: If the query is about anything else.

Examples:
- "Who are the founders of Tradable?" -> {"category": "TRADABLE"}
- "What is the price of Bitcoin?" -> {"category": "ELIZAOS"}
- "How much are Tradable's fees?" -> {"category": "TRADABLE"}
- "Analyze the current SOL sentiment" -> {"category": "ELIZAOS"}
- "How do I build a bot on Tradable?" -> {"category": "TRADABLE"}

Output only valid JSON.`;

/**
 * @param {"small"|"large"} size
 * @returns {string} the configured model id
 * @throws {Error} when neither the GOOGLE_* nor the bare key is set
 */
function resolveModel(size) {
  const googleKey = size === "small" ? "GOOGLE_SMALL_MODEL" : "GOOGLE_LARGE_MODEL";
  const bareKey = size === "small" ? "SMALL_MODEL" : "LARGE_MODEL";
  const model = process.env[googleKey]?.trim() || process.env[bareKey]?.trim();
  if (!model) {
    throw new Error(`${googleKey} (or ${bareKey}) is not set in the environment file.`);
  }

  return model;
}

/**
 * Map the oracle's conversation history to Gemini `contents`.
 * Eliza: { role: 'assistant' } -> Gemini: { role: 'model' }; everything else is `user`.
 * @param {Array<{role: string, content: string}>} conversationHistory
 * @returns {Array<{role: "user"|"model", parts: Array<{text: string}>}>}
 */
function toGeminiContents(conversationHistory) {
  return conversationHistory.map((turn) => ({
    role: turn.role === "assistant" ? "model" : "user",
    parts: [{ text: turn.content }],
  }));
}

/**
 * One `generateContent` round trip. The API key travels in a header, never in the URL, so it
 * cannot leak through request logs or traces.
 * @param {object} opts
 * @param {string} opts.model - Gemini model id
 * @param {Array<object>} opts.contents - Gemini `contents`
 * @param {object} [opts.generationConfig]
 * @param {typeof fetch} [opts.fetchImpl] - injectable for tests
 * @returns {Promise<string>} the concatenated text of the first candidate
 * @throws {Error} on a missing key, a non-2xx response, or a response without text
 */
async function generateContent({ model, contents, generationConfig, fetchImpl = fetch }) {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("GOOGLE_GENERATIVE_AI_API_KEY is not set in the environment file.");
  }

  const body = generationConfig ? { contents, generationConfig } : { contents };
  const res = await fetchImpl(`${GEMINI_API_BASE}/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Gemini (${model}) responded with status: ${res.status}`);
  }

  const json = await res.json();
  const parts = json?.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((part) => part?.text ?? "").join("");
  if (!text) {
    throw new Error(`Gemini (${model}) returned no text candidate.`);
  }

  return text;
}

/**
 * Classify the latest user message as TRADABLE or MARKET. Never throws.
 * @param {Array<{role: string, content: string}>} conversationHistory
 * @param {{fetchImpl?: typeof fetch}} [opts]
 * @returns {Promise<"TRADABLE"|"MARKET">}
 */
async function classifyIntent(conversationHistory, { fetchImpl } = {}) {
  const latestMessage = conversationHistory[conversationHistory.length - 1]?.content ?? "";
  console.log(`[Routing] Classifying intent for message: "${latestMessage.substring(0, 50)}..."`);

  try {
    const text = await generateContent({
      model: resolveModel("small"),
      contents: [
        { role: "user", parts: [{ text: `${ROUTING_INSTRUCTIONS}\nQuery: "${latestMessage}"` }] },
      ],
      generationConfig: {
        temperature: ROUTING_TEMPERATURE,
        responseMimeType: "application/json",
        responseSchema: INTENT_SCHEMA,
      },
      fetchImpl,
    });
    const category = JSON.parse(text).category === "TRADABLE" ? "TRADABLE" : "MARKET";
    console.log(`[Routing] Decision: ${category}`);

    return category;
  } catch (err) {
    console.error("[Routing] Classification failed, defaulting to MARKET path.", err);

    return "MARKET";
  }
}

/**
 * Last-resort answer straight from Gemini with the full conversation. Throws on failure.
 * @param {Array<{role: string, content: string}>} conversationHistory
 * @param {{fetchImpl?: typeof fetch}} [opts]
 * @returns {Promise<string>}
 */
async function queryGeminiDirect(conversationHistory, { fetchImpl } = {}) {
  const model = resolveModel("large");
  console.log(`[GeminiDirect] Querying ${model} directly (no agent runtime)...`);
  const text = await generateContent({
    model,
    contents: toGeminiContents(conversationHistory),
    fetchImpl,
  });
  console.log(`[GeminiDirect] Response received (${text.length} chars)`);

  return text;
}

module.exports = {
  classifyIntent,
  queryGeminiDirect,
  generateContent,
  toGeminiContents,
  GEMINI_API_BASE,
  INTENT_SCHEMA,
};
