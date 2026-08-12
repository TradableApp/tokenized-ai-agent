const path = require("node:path");

const { expect } = require("chai");

// GET_NEWS_DETAILS — the oracle's port of sense-ai-core's news action. CU-86d3z0r81.
//
// WHY THIS BODY NEEDED THE ACTION AT ALL. Both bodies inject byte-identical news context, but
// only core named a way to act on it. Given ten fresh articles and no sanctioned path past the
// headlines, this body's model reached for CALL_MCP_TOOL, searched the CoinGecko SDK docs, and
// answered a news question with a TypeScript snippet. The action and the provider instruction
// that points at it are one change; `brainProviders.test.js` covers the instruction half.
//
// WHAT THESE TESTS GUARD. The port is deliberately near-verbatim, so the interesting failures
// are not in the copied logic — they are at the two seams where the bodies genuinely differ:
// how the ledger is reached (BrainService, not runtime.db) and what happens to billing when
// that reach fails.
//
// READ THIS BEFORE TRUSTING THE `isBillable` ASSERTIONS BELOW.
//
// `isBillable` is asserted in several tests here, but NOTHING ON THIS BODY READS IT YET. In
// sense-ai-core the flag is consumed by `evaluators/usageTracker.ts` (`isBillable === false`
// marks the turn free); the oracle has no equivalent, and `aiAgentOracle.js` does not consult it
// before `contract.submitAnswer`. Confirmed by grep, not assumption.
//
// That is a DECISION, not an oversight: the oracle must always deliver an answer for a pre-paid,
// immutable prompt, and gating the charge was explicitly deferred rather than blocking the port
// (see CU-86d3z0r81). What actually protects the user on the error path today is that the
// failure returns before `handleChainSynthesis`, so no answer is synthesised or stored.
//
// So these assertions pin the CONTRACT — the shape core consumes, and the seam an oracle-side
// consumer will read — not a live enforcement path on this body. Wiring or permanently deciding
// it is CU-86d40gvmx. Do not read a passing `isBillable: false` here as "the user was not
// charged"; today it means "the action reported that it should not be".

const DIST = path.resolve(__dirname, "../src/elizaos/plugins/plugin-senseai/dist/index.js");

/** Mid-chain, so handleChainSynthesis returns before touching composeState/TEXT_LARGE. */
const MID_CHAIN = { actionPlan: { currentStep: 1, totalSteps: 2 } };

const ROWS = [
  {
    title: "BTC ETF inflows accelerate",
    url: "https://example.test/a",
    source: "CoinDesk",
    fullContent: "Institutional desks added to spot ETF positions.",
    sentiment: "Bullish",
    publishedAt: "2026-08-01T00:00:00.000Z",
    similarity: 0.82,
    metadata: { tier: 1 },
  },
];

/**
 * @param {object} opts
 * @param {(o:unknown)=>Promise<unknown[]>} [opts.search] BrainService.searchNewsDetails stand-in
 * @param {boolean} [opts.noBrain] omit the service entirely
 * @param {object|null} [opts.intent] what the extraction model returns
 * @param {unknown} [opts.embedding] what the embedding model returns
 */
function buildRuntime({ search, noBrain = false, intent = null, embedding = [0.1, 0.2] } = {}) {
  return {
    agentId: "agent-1",
    getService: (name) => {
      if (noBrain || name !== "brain") return null;
      return { searchNewsDetails: search };
    },
    getMemories: async () => [],
    useModel: async (_type, params) => {
      // Dispatch on the request shape rather than the ModelType constant, so the stub does not
      // have to import @elizaos/core just to name three enum members.
      if (params?.schema) return intent;
      if (params?.text !== undefined) return embedding;
      return "<response><thought>t</thought><text>synthesised</text></response>";
    },
    composeState: async () => ({ data: {}, values: {} }),
  };
}

describe("GET_NEWS_DETAILS (oracle port)", () => {
  let action;

  before(() => {
    const plugin = require(DIST).default;
    action = (plugin.actions || []).find((a) => a.name === "GET_NEWS_DETAILS");
  });

  it("is registered on the plugin", () => {
    expect(action, "the ticker is only actionable if this action is registered").to.exist;
  });

  it("reaches the ledger through BrainService, never through runtime.db", async () => {
    // THE STRUCTURAL DIVERGENCE FROM CORE, and the reason a straight copy would have been
    // silently wrong rather than broken. In the Social body `runtime.db` IS the shared `senseai`
    // cache. Here plugin-sql owns POSTGRES_URL pointed at the ISOLATED `oracle_agent` database,
    // which has no news table — core's line would compile, run, and query the wrong database.
    let called = null;
    const runtime = buildRuntime({
      intent: { type: "broad", query: "etf", tickers: ["BTC"] },
      search: async (opts) => {
        called = opts;
        return ROWS;
      },
    });
    // A db that explodes if touched: the action must never reach for it.
    Object.defineProperty(runtime, "db", {
      get() {
        throw new Error("runtime.db is the WRONG database on this body");
      },
    });

    const result = await action.handler(
      runtime,
      { roomId: "room-1", content: { text: "any etf news?" } },
      undefined,
      MID_CHAIN,
      async () => {},
      [],
    );

    expect(called, "the hybrid path must forward query, tickers and embedding").to.deep.equal({
      query: "etf",
      tickers: ["BTC"],
      embedding: [0.1, 0.2],
    });
    expect(result.success).to.equal(true);
    expect(result.data.isBillable).to.equal(true);
  });

  it("passes targetTitles ONLY on the specific-intent branch", async () => {
    // The Brain picks the title-lookup strategy purely on the presence of targetTitles, while
    // the `type === "specific"` gate lives here — so the caller keeps the strategy decision. A
    // model that volunteers titles on a broad query must not silently switch strategies.
    let called = null;
    const runtime = buildRuntime({
      intent: { type: "broad", query: "etf", targetTitles: ["Some headline"] },
      search: async (opts) => {
        called = opts;
        return ROWS;
      },
    });

    await action.handler(
      runtime,
      { roomId: "room-1", content: { text: "any etf news?" } },
      undefined,
      MID_CHAIN,
      async () => {},
      [],
    );

    expect(called).to.not.have.property("targetTitles");
  });

  it("uses the title-lookup strategy when the intent is specific", async () => {
    let called = null;
    const runtime = buildRuntime({
      intent: { type: "specific", targetTitles: ["BTC ETF inflows accelerate"] },
      search: async (opts) => {
        called = opts;
        return ROWS;
      },
    });

    await action.handler(
      runtime,
      { roomId: "room-1", content: { text: "tell me about that ETF piece" } },
      undefined,
      MID_CHAIN,
      async () => {},
      [],
    );

    expect(called).to.deep.equal({ targetTitles: ["BTC ETF inflows accelerate"] });
  });

  it("falls back to a text-only search when the embedding model fails", async () => {
    // #64: in the TEE the outbound proxy can hang a connection indefinitely. A null embedding
    // must degrade to text-only rather than stall the whole query.
    let called = null;
    const runtime = buildRuntime({
      intent: { type: "broad", query: "etf" },
      embedding: null,
      search: async (opts) => {
        called = opts;
        return ROWS;
      },
    });

    await action.handler(
      runtime,
      { roomId: "room-1", content: { text: "any etf news?" } },
      undefined,
      MID_CHAIN,
      async () => {},
      [],
    );

    expect(called.embedding).to.equal(null);
  });

  it("still answers when intent extraction fails, searching the raw message", async () => {
    let called = null;
    const runtime = buildRuntime({
      intent: null, // model hung or returned nothing
      search: async (opts) => {
        called = opts;
        return ROWS;
      },
    });

    await action.handler(
      runtime,
      { roomId: "room-1", content: { text: "any etf news?" } },
      undefined,
      MID_CHAIN,
      async () => {},
      [],
    );

    expect(called.query, "the raw message becomes the broad query").to.equal("any etf news?");
  });

  it("bills for a genuinely empty ledger — that is a real answer", async () => {
    // The other side of the billing contract. "We searched and found nothing" is information,
    // and core treats it as billable; the oracle must agree or the two bodies charge differently
    // for the same outcome.
    const runtime = buildRuntime({
      intent: { type: "broad", query: "etf" },
      search: async () => [],
    });

    const result = await action.handler(
      runtime,
      { roomId: "room-1", content: { text: "any etf news?" } },
      undefined,
      MID_CHAIN,
      async () => {},
      [],
    );

    expect(result.success).to.equal(false);
    expect(result.data.isBillable, "an empty ledger is still an answer").to.equal(true);
    expect(result.text).to.contain("No significant records found");
  });

  it("does NOT bill when the search itself fails", async () => {
    // THE BILLING CONTRACT. On this body storing an answer IS charging for it —
    // EVMAIAgent.submitAnswer calls aiAgentEscrow.finalizePayment in the same transaction — so a
    // Cloud SQL blip that reads as "found nothing" bills the user, on-chain, for our outage.
    // This is why BrainService.searchNewsDetails propagates instead of degrading to [].
    const runtime = buildRuntime({
      intent: { type: "broad", query: "etf" },
      search: async () => {
        throw new Error("connection refused");
      },
    });

    const result = await action.handler(
      runtime,
      { roomId: "room-1", content: { text: "any etf news?" } },
      undefined,
      MID_CHAIN,
      async () => {},
      [],
    );

    expect(result.success).to.equal(false);
    expect(result.data.isBillable, "a failed query must never be billed").to.equal(false);
    expect(result.error, "the failure must be reported, not swallowed").to.contain(
      "connection refused",
    );
    expect(result.text).to.contain("Error accessing market ledger");
  });

  it("does NOT bill when the TITLE-LOOKUP query fails", async () => {
    // MIRRORS sense-ai-core's test of the same name, added there after a review round found the
    // billing contract covered only the hybrid path. The oracle has the identical exposure:
    // Strategy A issues its own query against the same Cloud SQL instance, so "tell me more about
    // that BlackRock article" could be charged during an outage while the same failure on a broad
    // query was not.
    //
    // Not safe to assume symmetry with the test above either — the two strategies take different
    // paths through the Brain (bare `.select()` vs a projection, different filters), so "the
    // hybrid path propagates" is not evidence that the title lookup does.
    //
    // It matters MORE here than in core: storing an answer on this body IS charging for it, since
    // submitAnswer and finalizePayment share a transaction.
    const runtime = buildRuntime({
      intent: { type: "specific", targetTitles: ["BTC ETF inflows accelerate"], query: null },
      search: async () => {
        throw new Error("connection refused");
      },
    });

    const result = await action.handler(
      runtime,
      { roomId: "room-1", content: { text: "tell me more about that ETF article" } },
      undefined,
      MID_CHAIN,
      async () => {},
      [],
    );

    expect(result.success).to.equal(false);
    expect(result.data.isBillable, "a failed title lookup must never be billed either").to.equal(
      false,
    );
    expect(result.error).to.contain("connection refused");
    expect(result.text).to.contain("Error accessing market ledger");
  });

  it("renders similarity as a percentage, or 'Exact' when the strategy did not rank", async () => {
    // MIRRORS sense-ai-core's guard for the same expression. Copied because the rendering is
    // core's and must stay identical — it lands in the LLM-facing observation, so a divergence
    // here changes what the two bodies put in front of the model.
    //
    // The `"Exact"` case is not hypothetical: the title-lookup strategy returns no `similarity`
    // at all, so every title lookup renders "Exact".
    const ranked = await action.handler(
      buildRuntime({ intent: { type: "broad", query: "etf" }, search: async () => ROWS }),
      { roomId: "room-1", content: { text: "any etf news?" } },
      undefined,
      MID_CHAIN,
      async () => {},
      [],
    );
    expect(ranked.data.articles, "the ranked query must produce one article").to.have.lengthOf(1);
    expect(ranked.data.articles[0].similarity, "0.82 must render as 82").to.equal(82);

    // A row with no `similarity` key — what Strategy A actually returns.
    const { similarity: _dropped, ...rowWithoutSimilarity } = ROWS[0];
    const unranked = await action.handler(
      buildRuntime({
        intent: { type: "specific", targetTitles: ["BTC ETF inflows accelerate"], query: null },
        search: async () => [rowWithoutSimilarity],
      }),
      { roomId: "room-1", content: { text: "tell me more about that ETF article" } },
      undefined,
      MID_CHAIN,
      async () => {},
      [],
    );
    expect(unranked.data.articles).to.have.lengthOf(1);
    expect(unranked.data.articles[0].similarity, "an unranked hit renders 'Exact'").to.equal(
      "Exact",
    );

    // A similarity of exactly 0 is RANKED, not unranked. core switched this from a truthiness
    // gate to `!= null` in its #88 precisely because the truthy form rendered 0 as "Exact" — the
    // opposite of the truth. Pinned here so the two bodies cannot drift back apart.
    const zero = await action.handler(
      buildRuntime({
        intent: { type: "broad", query: "etf" },
        search: async () => [{ ...ROWS[0], similarity: 0 }],
      }),
      { roomId: "room-1", content: { text: "any etf news?" } },
      undefined,
      MID_CHAIN,
      async () => {},
      [],
    );
    expect(zero.data.articles).to.have.lengthOf(1);
    expect(zero.data.articles[0].similarity, "similarity 0 is ranked, not 'Exact'").to.equal(0);
  });

  it("does NOT bill when the Brain service is unregistered", async () => {
    // Same contract at the other end: "we never looked" is not evidence that no articles exist.
    const runtime = buildRuntime({ noBrain: true, intent: { type: "broad", query: "etf" } });

    const result = await action.handler(
      runtime,
      { roomId: "room-1", content: { text: "any etf news?" } },
      undefined,
      MID_CHAIN,
      async () => {},
      [],
    );

    expect(result.success).to.equal(false);
    expect(result.data.isBillable).to.equal(false);
  });

  it("carries no BROADCASTS_LIVE kill switch", async () => {
    // ORACLE DIVERGENCE 2, asserted rather than merely commented. core opens its handler by
    // refusing to answer when BROADCASTS_LIVE=false — a launch-day switch that keeps the Telegram
    // bot quiet while data syncs. Here the escrow has already moved by the time the prompt is
    // emitted, so declining to answer means keeping the money and saying nothing.
    const previous = process.env.BROADCASTS_LIVE;
    process.env.BROADCASTS_LIVE = "false";
    try {
      const runtime = buildRuntime({
        intent: { type: "broad", query: "etf" },
        search: async () => ROWS,
      });

      const result = await action.handler(
        runtime,
        { roomId: "room-1", content: { text: "any etf news?" } },
        undefined,
        MID_CHAIN,
        async () => {},
        [],
      );

      expect(result.success, "a paid prompt must be answered regardless of the Social switch").to
        .equal(true);
    } finally {
      if (previous === undefined) delete process.env.BROADCASTS_LIVE;
      else process.env.BROADCASTS_LIVE = previous;
    }
  });

  it("formats the observation the way core does", async () => {
    const runtime = buildRuntime({
      intent: { type: "broad", query: "etf" },
      search: async () => ROWS,
    });

    const result = await action.handler(
      runtime,
      { roomId: "room-1", content: { text: "any etf news?" } },
      undefined,
      MID_CHAIN,
      async () => {},
      [],
    );

    expect(result.text).to.contain("### INTERNAL LEDGER OBSERVATION");
    expect(result.text).to.contain("TITLE: BTC ETF inflows accelerate");
    expect(result.text).to.contain("SOURCE: CoinDesk (2026-08-01)");
    expect(result.text).to.contain("SENTIMENT: Bullish");
    // metadata must survive into the structured payload: it reaches the synthesis prompt via
    // data.articles, and narrowing it away was a real regression during the Brain migration.
    expect(result.data.articles[0].metadata).to.deep.equal({ tier: 1 });
  });

  it("synthesises a final answer when it is the last step in the chain", async () => {
    // The oracle reduces N callbacks to ONE stored answer, so the synthesis path is the one that
    // actually produces what gets written on-chain.
    const emitted = [];
    const runtime = buildRuntime({
      intent: { type: "broad", query: "etf" },
      search: async () => ROWS,
    });

    await action.handler(
      runtime,
      { roomId: "room-1", content: { text: "any etf news?" } },
      undefined,
      {}, // no actionPlan -> last step
      async (payload) => {
        emitted.push(payload);
      },
      [],
    );

    expect(emitted.length, "the final step must deliver an answer").to.be.greaterThan(0);
    expect(emitted[emitted.length - 1].text).to.be.a("string").and.not.equal("");
  });
});
