const { expect } = require("chai");
const sinon = require("sinon");

const {
  sanitizeAnswer,
  _setSanitizerForTests,
  _resetForTests,
} = require("../src/outboundSanitizer");

// Outbound sanitisation at the STORAGE boundary — CU-86d3z0r81, the "route the final answer
// through sanitizeOutboundText" action step.
//
// WHY A BOUNDARY PASS WHEN handleChainSynthesis ALREADY SANITISES. It sanitises OUR synthesis,
// inside `generateSanitized`. It cannot sanitise what it never produced, and selectAnswer is
// explicitly allowed to return text from somewhere else:
//
//   - a third-party action's prose (plugin-mcp's handleToolResponse emits a reasoning pass),
//   - the acknowledgement, when nothing of ours spoke,
//   - a tool payload, on the incident path where every emission looked like one.
//
// None of those went near `generateSanitized`, and all three are stored verbatim into an
// immutable, already-paid-for MessageFile. So the sanitiser belongs where the answer LEAVES the
// harness, not only where our own text enters it.
//
// WHY THIS IS AN ORACLE-ONLY ADDITION AND NOT A PORT GAP. sense-ai-core does not do this: its
// plugin-bootstrap replies are chat messages a user can challenge, retry, or simply scroll past.
// The divergence traces to the pre-paid immutable answer — one of the three differences §2.7
// accepts as forced — and is recorded at the call site in aiAgentOracle.js.
//
// THE ASYMMETRY THAT SETS THE FALLBACK RULE. `sanitizeOutboundText` returns null for "this is a
// template leak, drop it". Core's autonomous callers CAN drop — skipping a tweet costs nothing.
// This body cannot: the user has paid and an empty answer fails the contract outright, which is
// the same invariant selectAnswer's incident path already encodes. So a rejection here degrades
// to the unsanitised text and shouts about it, rather than deleting the answer.

describe("outboundSanitizer", () => {
  afterEach(() => {
    _resetForTests();
    sinon.restore();
  });

  it("returns the cleaned text when the Brain sanitiser accepts it", async () => {
    // The real leak shape: the model echoes its template wrapper around otherwise fine prose.
    _setSanitizerForTests((text) => text.replace(/<\/?response>/g, "").trim());

    const cleaned = await sanitizeAnswer("<response>Bitcoin is consolidating near $61k.</response>");

    expect(cleaned).to.equal("Bitcoin is consolidating near $61k.");
  });

  it("leaves clean prose untouched", async () => {
    _setSanitizerForTests((text) => text);

    const answer = "Bitcoin ETF inflows accelerated 18% while spot volume thinned.";
    expect(await sanitizeAnswer(answer)).to.equal(answer);
  });

  it("falls back to the unsanitised answer when the sanitiser REJECTS it", async () => {
    // The load-bearing case. A rejection means "this looks like a leak" — but the alternative to
    // a suspect answer is no answer on a prompt that has already been charged on-chain.
    _setSanitizerForTests(() => null);
    const error = sinon.stub(console, "error");

    const suspect = "<post>The actual tweet content</post>";
    expect(await sanitizeAnswer(suspect)).to.equal(suspect);

    // Logged at ERROR deliberately: `oasis rofl machine logs` surfaces warn and error only, so
    // an INFO line inside the TEE is invisible to whoever is investigating a bad answer.
    expect(error.called, "a rejected answer must be visible in the TEE logs").to.equal(true);
  });

  it("distinguishes an EMPTY-string result from a rejection in the log", async () => {
    // `sanitizeOutboundText` is typed `string | null`, and only null means "leak — reject".
    // An empty string is not something the current implementation can produce (every non-null
    // exit has cleared a >= 10 meaningful-character floor), but the signature permits it, and
    // reporting a template leak that never happened sends whoever is tracing a suspect stored
    // answer after the wrong cause.
    //
    // The OUTCOME is identical and deliberately so: degrade to the original either way. Storing
    // "" would turn an answer into no-answer on a prompt already charged on-chain, which no
    // quality rule is allowed to do.
    _setSanitizerForTests(() => "");
    const error = sinon.stub(console, "error");

    const answer = "Bitcoin is consolidating near $61k.";
    expect(await sanitizeAnswer(answer)).to.equal(answer);

    const logged = error.getCall(0).args[0];
    expect(logged, "an empty result is not a leak and must not be reported as one").to.not.match(
      /REJECTED/,
    );
    expect(logged).to.match(/EMPTY string/);
  });

  it("never stores a truthy NON-string, even though the contract forbids one", async () => {
    // One step from an immutable MessageFile the user has paid for, so truthiness alone is not
    // enough. The concrete route is the Brain making sanitizeOutboundText async: the value
    // becomes a Promise, which is truthy, and the caller's `.trim()` throws on a paid prompt.
    _setSanitizerForTests(() => Promise.resolve("looks fine"));
    const error = sinon.stub(console, "error");

    const answer = "Bitcoin is consolidating near $61k.";
    expect(await sanitizeAnswer(answer), "the original ships, not the Promise").to.equal(answer);
    expect(error.getCall(0).args[0]).to.match(/not a string/);
  });

  it("reports UNDEFINED as its own case, not as a template leak", async () => {
    // `null` sends an operator to the emitting action hunting a template leak; `undefined` means
    // the Brain fell off a path without returning — a different repo and a different bug. On the
    // TEE the log line is the only visibility, so conflating them costs a wasted investigation.
    _setSanitizerForTests(() => undefined);
    const error = sinon.stub(console, "error");

    const answer = "Bitcoin is consolidating near $61k.";
    expect(await sanitizeAnswer(answer)).to.equal(answer);

    const logged = error.getCall(0).args[0];
    expect(logged).to.match(/UNDEFINED/);
    expect(logged, "must not blame the emitting action").to.not.match(/REJECTED/);
  });

  it("falls back to the unsanitised answer when the sanitiser THROWS", async () => {
    _setSanitizerForTests(() => {
      throw new Error("brain exploded");
    });
    sinon.stub(console, "error");

    const answer = "Bitcoin is consolidating near $61k.";
    expect(await sanitizeAnswer(answer)).to.equal(answer);
  });

  it("falls back to the unsanitised answer when the Brain cannot be loaded", async () => {
    // Localnet e2e runs with no Cloud SQL and, in some builds, no Brain at all. That must cost
    // the sanitising pass, never the answer.
    _setSanitizerForTests(null, { loadFails: true });
    sinon.stub(console, "error");

    const answer = "Bitcoin is consolidating near $61k.";
    expect(await sanitizeAnswer(answer)).to.equal(answer);
  });

  it("passes null and empty answers straight through", async () => {
    // selectAnswer already returns null when nothing usable was emitted; this module must not
    // turn that into a different failure shape for the caller to handle twice.
    _setSanitizerForTests(() => "should never be called");

    expect(await sanitizeAnswer(null)).to.equal(null);
    expect(await sanitizeAnswer("   ")).to.equal("   ");
  });

  it("refuses a sanitizer and loader options together", () => {
    // The seam's own guard. `loadSanitizer` returns on `overrideSanitizer` before consulting
    // `overrideLoader`, so a test passing both would exercise only the first — and still pass,
    // against the path it did not mean to test. Failing loudly at setup beats that.
    expect(() => _setSanitizerForTests(() => "x", { loadFails: true })).to.throw(
      /mutually exclusive|EITHER/i,
    );
    expect(() => _setSanitizerForTests(() => "x", { loader: async () => ({}) })).to.throw(
      /mutually exclusive|EITHER/i,
    );
  });

  it("refuses loader and loadFails together, even with no sanitizer", () => {
    // The first guard keys off `sanitizer`, so a null sanitizer walks straight past it. Inside
    // the function `loadFails` wins over `loader`, meaning a test that passed both would run
    // against the failing-load path while its author believed it was driving their own loader —
    // and would still pass.
    expect(() =>
      _setSanitizerForTests(null, { loader: async () => ({}), loadFails: true }),
    ).to.throw(/mutually exclusive/i);
  });

  it("loads the Brain once and reuses it across answers", async () => {
    // The TEE answers on a p-queue at concurrency 5. Re-importing the Brain barrel per answer
    // would pull adapters and drizzle into every one of them.
    const sanitizer = sinon.stub().callsFake((t) => t);
    // Resolves a MODULE, not a bare function — the loader's contract is the Brain barrel, and a
    // stub that resolved something else would let the production code drop its `.sanitizeOutboundText`
    // lookup while this test still passed.
    const loader = sinon.stub().resolves({ sanitizeOutboundText: sanitizer });
    _setSanitizerForTests(null, { loader });

    await sanitizeAnswer("first answer, long enough to matter");
    await sanitizeAnswer("second answer, long enough to matter");

    expect(loader.callCount, "the Brain barrel must be imported once per process").to.equal(1);
    expect(sanitizer.callCount).to.equal(2);
  });

  it("SHOUTS when the Brain loads but no longer exports the sanitiser", async () => {
    // The one silent path that was left. A failed import hits the `.catch` and logs; a module
    // that loads successfully but has renamed or dropped the export used to return null with no
    // signal at all — disabling sanitisation on every paid prompt with nothing to observe. In
    // the TEE that is invisible, since `oasis rofl machine logs` surfaces warn and error only.
    const loader = sinon.stub().resolves({ somethingElse: () => "x" });
    _setSanitizerForTests(null, { loader });
    const error = sinon.stub(console, "error");

    const answer = "Bitcoin is consolidating near $61k.";
    expect(await sanitizeAnswer(answer), "the answer still ships").to.equal(answer);

    const logged = error.getCalls().map((c) => c.args[0]).join("\n");
    expect(logged, "a renamed Brain export must not fail silently").to.match(
      /does not export sanitizeOutboundText/,
    );
  });

  it("retries a failed load ONCE, then caches the failure", async () => {
    // The two failure shapes pull opposite ways. A missing module is deterministic — retrying it
    // on every paid prompt costs an import attempt forever for nothing. But a first answer can
    // arrive while the container is still warming, and caching THAT permanently leaves every
    // later answer unsanitised behind a single log line.
    //
    // One retry separates them, so this asserts BOTH halves: attempt two happens, attempt three
    // does not.
    const loader = sinon.stub().rejects(new Error("Cannot find module"));
    _setSanitizerForTests(null, { loader });
    sinon.stub(console, "error");

    await sanitizeAnswer("first answer, long enough to matter");
    expect(loader.callCount, "the first failure must not be final").to.equal(1);

    await sanitizeAnswer("second answer, long enough to matter");
    expect(loader.callCount, "one retry, for a warm-up blip").to.equal(2);

    await sanitizeAnswer("third answer, long enough to matter");
    await sanitizeAnswer("fourth answer, long enough to matter");
    expect(loader.callCount, "then it stops — a missing module is deterministic").to.equal(2);
  });

  it("recovers when the retry succeeds", async () => {
    // The case the retry exists for: the import fails once during warm-up and works on the
    // second attempt. Without the retry this process would store every answer unsanitised.
    const sanitizer = sinon.stub().callsFake((t) => `${t} [clean]`);
    const loader = sinon.stub();
    loader.onFirstCall().rejects(new Error("still warming"));
    loader.onSecondCall().resolves({ sanitizeOutboundText: sanitizer });
    _setSanitizerForTests(null, { loader });
    sinon.stub(console, "error");

    const first = await sanitizeAnswer("first answer, long enough to matter");
    expect(first, "the first answer ships unsanitised").to.equal(
      "first answer, long enough to matter",
    );

    const second = await sanitizeAnswer("second answer, long enough to matter");
    expect(second, "and the second is sanitised — the process recovered").to.equal(
      "second answer, long enough to matter [clean]",
    );
  });
});
