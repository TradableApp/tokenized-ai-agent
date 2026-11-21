const { expect } = require("chai");

const { initInboundPrompt } = require("../src/inboundPrompt");
const outbound = require("../src/outboundSanitizer");
const {
  sanitizeThought,
  THOUGHT_SANITIZE_TIMEOUT_MS,
  THOUGHT_MAX_CHARS,
} = require("../src/stream/thoughtSanitizer");

// A thought is shown live and stored with the answer for good, so it is cleaned ONCE, here,
// before either. Unlike the answer, a thought is not what the user paid for: anything doubtful is
// dropped rather than kept.

describe("thought sanitiser", () => {
  before(async () => {
    await initInboundPrompt();
  });

  afterEach(() => {
    outbound._resetForTests();
  });

  it("keeps an ordinary thought as it is", async () => {
    expect(await sanitizeThought("Checked recent sentiment for BTC.")).to.equal(
      "Checked recent sentiment for BTC.",
    );
  });

  it("trims the thought", async () => {
    expect(await sanitizeThought("  Weighing the macro backdrop now.  ")).to.equal(
      "Weighing the macro backdrop now.",
    );
  });

  it("strips fence tags before anything else", async () => {
    const cleaned = await sanitizeThought(
      "<untrusted_conversation>The user wants a BTC price analysis today.</untrusted_conversation>",
    );

    expect(cleaned).to.be.a("string");
    expect(cleaned).to.not.include("untrusted_conversation");
    expect(cleaned).to.include("The user wants a BTC price analysis today.");
  });

  describe("never lets a tool payload out", () => {
    const payloads = {
      "a JSON document": '{"tool":"get_simple_price","args":{"ids":"bitcoin"}}',
      "a JSON array": '[{"id":"bitcoin","current_price":1}]',
      "fenced code alone": "```ts\nconst price = await getSimplePrice({ ids: 'bitcoin' });\n```",
      "a bare invocation": "await client.coins.markets({ vs_currency: 'usd' })",
    };

    for (const [name, text] of Object.entries(payloads)) {
      it(`drops ${name}`, async () => {
        expect(await sanitizeThought(text)).to.equal(null);
      });
    }

    it("drops the tool plugin's account of a failed tool step", async () => {
      // The thought the MCP plugin sends with its apology (see toolFailureKind).
      for (const thought of [
        "Error calling MCP tool get_simple_price: the provider answered 500 for this request.",
        "No appropriate MCP tool available for this request. I will answer without one.",
        "Failed to parse response after multiple retries. Asking the user to say it again.",
      ]) {
        expect(await sanitizeThought(thought), thought).to.equal(null);
      }
    });
  });

  it("drops what the Brain rejects (a thought too short to be a step)", async () => {
    expect(await sanitizeThought("ok")).to.equal(null);
  });

  it("drops an empty, blank or non-string thought", async () => {
    for (const value of ["", "   ", null, undefined, 42, {}]) {
      expect(await sanitizeThought(value), String(value)).to.equal(null);
    }
  });

  it("caps a kept thought at the step description limit", async () => {
    const long = `Reading the market. ${"a".repeat(THOUGHT_MAX_CHARS * 2)}`;

    const cleaned = await sanitizeThought(long);

    expect(THOUGHT_MAX_CHARS).to.equal(4000);
    expect(cleaned).to.have.length(THOUGHT_MAX_CHARS);
  });

  it("drops the thought when the sanitiser cannot be loaded, rather than keeping it unsanitised", async () => {
    outbound._setSanitizerForTests(null, { loadFails: true });

    expect(await sanitizeThought("Checked recent sentiment for BTC.")).to.equal(null);
  });

  it("drops the thought when the sanitiser throws", async () => {
    outbound._setSanitizerForTests(() => {
      throw new Error("boom");
    });

    expect(await sanitizeThought("Checked recent sentiment for BTC.")).to.equal(null);
  });

  it("drops the thought when the sanitiser returns something other than text", async () => {
    outbound._setSanitizerForTests(() => Promise.resolve("later"));

    expect(await sanitizeThought("Checked recent sentiment for BTC.")).to.equal(null);
  });

  it("gives up on a sanitiser that hangs, within its time limit, and drops the thought", async () => {
    outbound._setSanitizerForTests(null, { loader: () => new Promise(() => {}) });

    const started = Date.now();
    const cleaned = await sanitizeThought("Checked recent sentiment for BTC.", { timeoutMs: 50 });

    expect(cleaned).to.equal(null);
    expect(Date.now() - started).to.be.lessThan(1000);
    expect(THOUGHT_SANITIZE_TIMEOUT_MS).to.equal(2000);
  });

  it("never throws, even when the fence strip is not ready", async () => {
    const inbound = require("../src/inboundPrompt");
    inbound._resetForTests();
    try {
      expect(await sanitizeThought("Checked recent sentiment for BTC.")).to.equal(null);
    } finally {
      await initInboundPrompt();
    }
  });
});
