const chai = require("chai");
const sinon = require("sinon");

const chaiAsPromised = require("chai-as-promised");

chai.use(chaiAsPromised.default ?? chaiAsPromised);
const { expect } = chai;

// Direct Gemini calls for the two jobs the in-TEE Ollama sidecar used to do (CU-14ym9bve42k):
// intent routing and the last-resort answer tier. Ollama was removed because the gemma3:1b
// manifest was re-published behind a newer client floor (HTTP 412 at boot) and every Ollama
// image that clears that floor is larger than the persistent disk the medium ROFL offer allows.
// A boot-time pull from a mutable registry inside a TEE is not something we want to depend on.
//
// These calls deliberately bypass the ElizaOS runtime. The ElizaOS path already uses Gemini via
// plugin-google-genai, so a plain generateContent call is a DIFFERENT failure domain (no agent
// pipeline, no plugin-sql, no MCP) and still a meaningful last resort when that path throws for
// reasons other than Gemini itself being down.

const {
  classifyIntent,
  queryGeminiDirect,
  generateContent,
  toGeminiContents,
  GEMINI_API_BASE,
} = require("../src/geminiDirect");

const HISTORY = [
  { role: "user", content: "Hi there" },
  { role: "assistant", content: "Hello! How can I help?" },
  { role: "user", content: "How much are Tradable's fees?" },
];

function geminiResponse(text, overrides = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
    text: async () => "",
    ...overrides,
  };
}

function fetchResolving(response) {
  return sinon.stub().resolves(response);
}

describe("geminiDirect", () => {
  const savedEnv = {};
  const ENV_KEYS = [
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "GOOGLE_SMALL_MODEL",
    "GOOGLE_LARGE_MODEL",
    "SMALL_MODEL",
    "LARGE_MODEL",
  ];

  beforeEach(() => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-key";
    process.env.GOOGLE_SMALL_MODEL = "small-model-id";
    process.env.GOOGLE_LARGE_MODEL = "large-model-id";
    delete process.env.SMALL_MODEL;
    delete process.env.LARGE_MODEL;
    sinon.stub(console, "log");
    sinon.stub(console, "error");
    sinon.stub(console, "warn");
  });

  afterEach(() => {
    sinon.restore();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  describe("toGeminiContents", () => {
    it("maps assistant turns to the `model` role and everything else to `user`", () => {
      expect(toGeminiContents(HISTORY)).to.deep.equal([
        { role: "user", parts: [{ text: "Hi there" }] },
        { role: "model", parts: [{ text: "Hello! How can I help?" }] },
        { role: "user", parts: [{ text: "How much are Tradable's fees?" }] },
      ]);
    });
  });

  describe("generateContent", () => {
    it("POSTs to the model's generateContent endpoint with the API key header and returns the text", async () => {
      const fetchImpl = fetchResolving(geminiResponse("answer text"));

      const text = await generateContent({
        model: "some-model",
        contents: toGeminiContents(HISTORY),
        fetchImpl,
      });

      expect(text).to.equal("answer text");
      expect(fetchImpl.calledOnce).to.be.true;
      const [url, init] = fetchImpl.firstCall.args;
      expect(url).to.equal(`${GEMINI_API_BASE}/some-model:generateContent`);
      expect(init.method).to.equal("POST");
      expect(init.headers["x-goog-api-key"]).to.equal("test-key");
      expect(init.headers["Content-Type"]).to.equal("application/json");
      expect(JSON.parse(init.body).contents).to.have.length(3);
      // The key travels in a header, never in the URL (URLs end up in logs and traces).
      expect(url).to.not.include("test-key");
    });

    it("joins multi-part candidates into one string", async () => {
      const fetchImpl = fetchResolving({
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: "a" }, { text: "b" }] } }],
        }),
      });

      expect(await generateContent({ model: "m", contents: [], fetchImpl })).to.equal("ab");
    });

    it("throws when the API key is missing without calling fetch", async () => {
      delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      const fetchImpl = fetchResolving(geminiResponse("x"));

      await expect(generateContent({ model: "m", contents: [], fetchImpl })).to.be.rejectedWith(
        /GOOGLE_GENERATIVE_AI_API_KEY/,
      );
      expect(fetchImpl.called).to.be.false;
    });

    it("throws with the HTTP status when the response is not ok", async () => {
      const fetchImpl = fetchResolving({ ok: false, status: 503, text: async () => "overloaded" });

      await expect(generateContent({ model: "m", contents: [], fetchImpl })).to.be.rejectedWith(
        /503/,
      );
    });

    it("throws when the response carries no text candidate", async () => {
      const fetchImpl = fetchResolving({
        ok: true,
        status: 200,
        json: async () => ({ candidates: [] }),
      });

      await expect(generateContent({ model: "m", contents: [], fetchImpl })).to.be.rejectedWith(
        /no text/i,
      );
    });
  });

  describe("classifyIntent", () => {
    it('returns TRADABLE when the model answers {"category":"TRADABLE"}', async () => {
      const fetchImpl = fetchResolving(geminiResponse('{"category":"TRADABLE"}'));

      expect(await classifyIntent(HISTORY, { fetchImpl })).to.equal("TRADABLE");
    });

    it("returns MARKET for the ELIZAOS category", async () => {
      const fetchImpl = fetchResolving(geminiResponse('{"category":"ELIZAOS"}'));

      expect(await classifyIntent(HISTORY, { fetchImpl })).to.equal("MARKET");
    });

    it("asks the SMALL model for JSON constrained to the category schema, about the latest message only", async () => {
      const fetchImpl = fetchResolving(geminiResponse('{"category":"TRADABLE"}'));

      await classifyIntent(HISTORY, { fetchImpl });

      const [url, init] = fetchImpl.firstCall.args;
      expect(url).to.equal(`${GEMINI_API_BASE}/small-model-id:generateContent`);
      const body = JSON.parse(init.body);
      expect(body.contents).to.have.length(1);
      expect(body.contents[0].parts[0].text).to.include("How much are Tradable's fees?");
      expect(body.contents[0].parts[0].text).to.not.include("Hi there");
      expect(body.generationConfig.responseMimeType).to.equal("application/json");
      expect(body.generationConfig.responseSchema.properties.category.enum).to.deep.equal([
        "TRADABLE",
        "ELIZAOS",
      ]);
      expect(body.generationConfig.temperature).to.be.lessThan(0.5);
    });

    it("falls back to SMALL_MODEL when GOOGLE_SMALL_MODEL is unset", async () => {
      delete process.env.GOOGLE_SMALL_MODEL;
      process.env.SMALL_MODEL = "plain-small";
      const fetchImpl = fetchResolving(geminiResponse('{"category":"TRADABLE"}'));

      await classifyIntent(HISTORY, { fetchImpl });

      expect(fetchImpl.firstCall.args[0]).to.equal(
        `${GEMINI_API_BASE}/plain-small:generateContent`,
      );
    });

    it("defaults to MARKET on malformed JSON", async () => {
      const fetchImpl = fetchResolving(geminiResponse("not json at all"));

      expect(await classifyIntent(HISTORY, { fetchImpl })).to.equal("MARKET");
    });

    it("defaults to MARKET on an HTTP error", async () => {
      const fetchImpl = fetchResolving({ ok: false, status: 500, text: async () => "boom" });

      expect(await classifyIntent(HISTORY, { fetchImpl })).to.equal("MARKET");
    });

    it("defaults to MARKET when fetch itself rejects", async () => {
      const fetchImpl = sinon.stub().rejects(new Error("ECONNRESET"));

      expect(await classifyIntent(HISTORY, { fetchImpl })).to.equal("MARKET");
    });

    it("defaults to MARKET when no API key is configured, without calling fetch", async () => {
      delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      const fetchImpl = fetchResolving(geminiResponse('{"category":"TRADABLE"}'));

      expect(await classifyIntent(HISTORY, { fetchImpl })).to.equal("MARKET");
      expect(fetchImpl.called).to.be.false;
    });

    it("defaults to MARKET when no small model id is configured", async () => {
      delete process.env.GOOGLE_SMALL_MODEL;
      const fetchImpl = fetchResolving(geminiResponse('{"category":"TRADABLE"}'));

      expect(await classifyIntent(HISTORY, { fetchImpl })).to.equal("MARKET");
      expect(fetchImpl.called).to.be.false;
    });
  });

  describe("queryGeminiDirect", () => {
    it("sends the whole mapped history to the LARGE model and returns its text", async () => {
      const fetchImpl = fetchResolving(geminiResponse("direct answer"));

      const text = await queryGeminiDirect(HISTORY, { fetchImpl });

      expect(text).to.equal("direct answer");
      const [url, init] = fetchImpl.firstCall.args;
      expect(url).to.equal(`${GEMINI_API_BASE}/large-model-id:generateContent`);
      const body = JSON.parse(init.body);
      expect(body.contents.map((c) => c.role)).to.deep.equal(["user", "model", "user"]);
      expect(body.generationConfig?.responseMimeType).to.be.undefined;
    });

    it("falls back to LARGE_MODEL when GOOGLE_LARGE_MODEL is unset", async () => {
      delete process.env.GOOGLE_LARGE_MODEL;
      process.env.LARGE_MODEL = "plain-large";
      const fetchImpl = fetchResolving(geminiResponse("x"));

      await queryGeminiDirect(HISTORY, { fetchImpl });

      expect(fetchImpl.firstCall.args[0]).to.equal(
        `${GEMINI_API_BASE}/plain-large:generateContent`,
      );
    });

    it("throws (does not swallow) when Gemini fails, so the dispatcher can record `none`", async () => {
      const fetchImpl = fetchResolving({ ok: false, status: 429, text: async () => "quota" });

      await expect(queryGeminiDirect(HISTORY, { fetchImpl })).to.be.rejectedWith(/429/);
    });

    it("throws when no large model id is configured", async () => {
      delete process.env.GOOGLE_LARGE_MODEL;
      const fetchImpl = fetchResolving(geminiResponse("x"));

      await expect(queryGeminiDirect(HISTORY, { fetchImpl })).to.be.rejectedWith(
        /GOOGLE_LARGE_MODEL/,
      );
      expect(fetchImpl.called).to.be.false;
    });
  });
});
