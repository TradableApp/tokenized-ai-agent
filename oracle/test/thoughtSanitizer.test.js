const { expect } = require("chai");

const { initInboundPrompt } = require("../src/inboundPrompt");
const outbound = require("../src/outboundSanitizer");
const {
  sanitizeThought,
  warmThoughtSanitizer,
  THOUGHT_SANITIZE_TIMEOUT_MS,
  THOUGHT_MAX_CHARS,
  THOUGHT_SANITIZE_INPUT_MAX_CHARS,
} = require("../src/stream/thoughtSanitizer");
const { streamCounters } = require("../src/stream/answerStream");

const dropped = () => streamCounters.snapshot().thoughtsDropped;
const droppedSince = (before) => {
  const now = dropped();
  return Object.fromEntries(Object.keys(now).map((kind) => [kind, now[kind] - before[kind]]));
};
const none = { timeout: 0, unavailable: 0, refused: 0, failed: 0, late: 0 };

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

  describe("counts what it drops, by kind only", () => {
    it("counts a sanitiser that cannot be loaded as unavailable", async () => {
      outbound._setSanitizerForTests(null, { loadFails: true });
      const before = dropped();

      await sanitizeThought("Checked recent sentiment for BTC.");

      expect(droppedSince(before)).to.deep.equal({ ...none, unavailable: 1 });
    });

    it("counts a sanitiser that does not answer in time as timeout", async () => {
      outbound._setSanitizerForTests(null, { loader: () => new Promise(() => {}) });
      const before = dropped();

      await sanitizeThought("Checked recent sentiment for BTC.", { timeoutMs: 20 });

      expect(droppedSince(before)).to.deep.equal({ ...none, timeout: 1 });
    });

    it("counts what the Brain rejects as refused", async () => {
      const before = dropped();

      await sanitizeThought("ok");

      expect(droppedSince(before)).to.deep.equal({ ...none, refused: 1 });
    });

    it("counts a sanitiser that throws, or answers with something other than text, as failed", async () => {
      outbound._setSanitizerForTests(() => {
        throw new Error("boom");
      });
      const before = dropped();
      await sanitizeThought("Checked recent sentiment for BTC.");
      outbound._setSanitizerForTests(() => Promise.resolve("later"));
      await sanitizeThought("Checked recent sentiment for BTC.");

      expect(droppedSince(before)).to.deep.equal({ ...none, failed: 2 });
    });

    it("does not count what it drops by design, or what it keeps", async () => {
      const before = dropped();

      await sanitizeThought('{"tool":"get_simple_price","args":{"ids":"bitcoin"}}');
      await sanitizeThought("   ");
      await sanitizeThought(null);
      await sanitizeThought("Checked recent sentiment for BTC.");

      expect(droppedSince(before)).to.deep.equal(none);
    });
  });

  describe("bounds the text it hands the Brain", () => {
    it("cuts a thought far over the bound before the Brain sees it, then caps the result", async () => {
      const seen = [];
      outbound._setSanitizerForTests((text) => {
        seen.push(text.length);
        return text;
      });

      const cleaned = await sanitizeThought(`Reading the market. ${"<post>a".repeat(100000)}`);

      expect(THOUGHT_SANITIZE_INPUT_MAX_CHARS).to.equal(32 * 1024);
      expect(seen).to.have.length(1);
      expect(seen[0]).to.be.at.most(THOUGHT_SANITIZE_INPUT_MAX_CHARS);
      expect(cleaned).to.have.length(THOUGHT_MAX_CHARS);
    });

    it("hands an ordinary thought to the Brain whole", async () => {
      const seen = [];
      outbound._setSanitizerForTests((text) => {
        seen.push(text);
        return text;
      });
      const thought = `Weighing the macro backdrop. ${"b".repeat(THOUGHT_MAX_CHARS * 3)}`;

      await sanitizeThought(thought);

      expect(seen).to.deep.equal([thought]);
    });
  });

  describe("warm-up at start-up", () => {
    it("loads the sanitiser once, so the first thought does not wait for the load", async () => {
      let loads = 0;
      outbound._setSanitizerForTests(null, {
        loader: async () => {
          loads += 1;
          return { sanitizeOutboundText: (text) => text };
        },
      });

      expect(await warmThoughtSanitizer()).to.equal(true);
      expect(await sanitizeThought("Checked recent sentiment for BTC.")).to.equal(
        "Checked recent sentiment for BTC.",
      );
      expect(loads).to.equal(1);
    });

    it("never throws when the load fails, and says so by kind with nothing of the error's text", async () => {
      outbound._setSanitizerForTests(null, { loadFails: true });
      const warned = [];
      const originalWarn = console.warn;
      const originalError = console.error;
      console.warn = (...args) => warned.push(args.join(" "));
      console.error = () => {};
      let ready;
      try {
        ready = await warmThoughtSanitizer();
      } finally {
        console.warn = originalWarn;
        console.error = originalError;
      }

      expect(ready).to.equal(false);
      const line = warned.find((w) => w.includes("[Stream]"));
      expect(line).to.match(/unavailable/);
      expect(line).to.match(/thoughts are dropped/);
      expect(line).to.not.include("Cannot find module");
    });
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
