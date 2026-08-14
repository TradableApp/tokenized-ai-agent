const path = require("node:path");

const { expect } = require("chai");

// ANALYZE_ASSET_SENTIMENT — the oracle's port of sense-ai-core's sentiment action. CU-86d3z0r81.
//
// WHY THIS FILE EXISTS. The port shipped with service-level tests only (`brainService.test.js`),
// while the sibling action ported one PR earlier got a full action-level suite. That asymmetry was
// the gap: `isBillable` is computed in the ACTION, not the service, so no amount of service
// coverage reaches it. Raised by claude[bot] on #72 and fixed here.
//
// WHAT THESE TESTS GUARD. The port is deliberately near-verbatim — its executable diff against
// core is exactly two documented divergences — so the copied formatting logic is not the
// interesting failure surface. These pin the two seams where the bodies genuinely differ:
// how the ledger is reached (BrainService, not runtime.db) and what the billing gate does when
// that reach partially fails.
//
// READ THIS BEFORE TRUSTING THE `isBillable` ASSERTIONS BELOW.
//
// `isBillable` is asserted throughout, but NOTHING ON THIS BODY READS IT YET. In sense-ai-core the
// flag is consumed by `evaluators/usageTracker.ts` (`isBillable === false` marks the turn free);
// the oracle has no equivalent, and `aiAgentOracle.js` does not consult it before
// `contract.submitAnswer`. Confirmed by grep, not assumption. Same caveat as
// `getNewsDetails.test.js`, and for the same reason: the oracle must always deliver an answer for
// a pre-paid, immutable prompt, so gating the charge was deferred rather than blocking the port.
// Wiring or permanently deciding it is CU-86d40gvmx.
//
// Hence the "reports BILLABLE / NON-BILLABLE" naming below rather than "bills / does NOT bill":
// a failing test shows its TITLE first, and "does NOT bill" would send whoever reads that CI line
// hunting for a broken payment guard that does not exist yet.
//
// So these assertions pin the CONTRACT — the shape core consumes, and the seam an oracle-side
// consumer will read — not a live enforcement path. Do not read a passing `isBillable: false`
// here as "the user was not charged"; today it means "the action reported that it should not be".
//
// ON THE ABSENCE OF A RED PHASE. The behaviour under test was already correct, so there was no
// honest failing state to reach by writing these. The evidence is mutation instead: each of
// `successfulFetches > 0` -> `>= 0`, `> 0` -> `> 1`, deleting `successfulFetches++`, and hoisting
// the `continue` above the observation append must turn this file red. If a future edit makes any
// of those mutations survive, these tests have stopped pinning what they claim to.

const DIST = path.resolve(__dirname, "../src/elizaos/plugins/plugin-senseai/dist/index.js");

/** Mid-chain, so handleChainSynthesis returns before touching composeState/TEXT_LARGE. */
const MID_CHAIN = { actionPlan: { currentStep: 1, totalSteps: 2 } };

/**
 * A minimal AssetSentimentMetrics row. Most fields are intentionally absent — the formatters
 * render those as "N/A", which is core's behaviour and not what this file is testing.
 *
 * `_dataTimestamp` is omitted deliberately: it is falsy, so the age-warning branch stays out of
 * the observation and these assertions do not depend on the wall clock.
 */
const METRICS = {
  mvrv_usd_30d: 1.42,
  active_addresses_24h: 912_345,
  cfgi_fear_greed_score: 61,
};

/**
 * @param {object} opts
 * @param {Record<string, unknown|null>} [opts.ledger] ticker -> metrics, or null for "no data"
 * @param {boolean} [opts.noBrain] omit the service entirely
 * @param {object|null} [opts.extraction] what the ticker-extraction model returns
 * @param {(t:string)=>Promise<unknown>} [opts.getAssetSentiment] override the service outright
 */
function buildRuntime({ ledger = {}, noBrain = false, extraction = null, getAssetSentiment } = {}) {
  const fetched = [];

  const runtime = {
    agentId: "agent-1",
    fetched,
    getService: (name) => {
      if (noBrain || name !== "brain") return null;
      return {
        getAssetSentiment:
          getAssetSentiment ||
          (async (ticker) => {
            fetched.push(ticker);
            return ticker in ledger ? ledger[ticker] : null;
          }),
      };
    },
    getMemories: async () => [],
    useModel: async (_type, params) => {
      // Dispatch on the request shape rather than the ModelType constant, so the stub does not
      // have to import @elizaos/core just to name two enum members.
      if (params?.schema) return extraction;
      return "<response><thought>t</thought><text>synthesised</text></response>";
    },
    composeState: async () => ({ data: {}, values: {} }),
  };

  return runtime;
}

const MESSAGE = { roomId: "room-1", content: { text: "how is BTC looking?" } };

describe("ANALYZE_ASSET_SENTIMENT (oracle port)", () => {
  let action;

  before(() => {
    const plugin = require(DIST).default;
    action = (plugin.actions || []).find((a) => a.name === "ANALYZE_ASSET_SENTIMENT");
  });

  it("is registered on the plugin", () => {
    expect(action, "the action is unreachable unless it is registered").to.exist;
  });

  it("reaches the ledger through BrainService, never through runtime.db", async () => {
    // ORACLE DIVERGENCE 1, pinned. In the Social body `runtime.db` IS the shared `senseai` cache,
    // so core resolves SentimentService and lets its engine read straight from it. Here plugin-sql
    // points the runtime at the ISOLATED `oracle_agent` database, which has no `sentiment_history`
    // table — core's line would compile, run, and query the wrong database.
    const runtime = buildRuntime({
      extraction: { tickers: ["BTC"] },
      ledger: { BTC: METRICS },
    });
    // A db that explodes if touched: the action must never reach for it.
    Object.defineProperty(runtime, "db", {
      get() {
        throw new Error("runtime.db is the WRONG database on this body");
      },
    });

    const result = await action.handler(runtime, MESSAGE, undefined, MID_CHAIN, async () => {}, []);

    expect(runtime.fetched, "the ticker must be fetched via the service").to.deep.equal(["BTC"]);
    expect(result.success).to.equal(true);
    expect(result.data.isBillable).to.equal(true);
  });

  it("reports BILLABLE when at least one ticker resolves, even if the others return null", async () => {
    // THE BILLING GATE, and the case the review singled out. `isBillable: successfulFetches > 0`
    // is what a future oracle-side consumer will read before finalising an on-chain payment, and
    // partial success is the only input that distinguishes `> 0` from the two mutations either
    // side of it (`>= 0` and `> 1`). All-resolve and all-null both survive those.
    const runtime = buildRuntime({
      extraction: { tickers: ["BTC", "ETH"] },
      ledger: { BTC: METRICS, ETH: null },
    });

    const seen = [];
    const result = await action.handler(
      runtime,
      MESSAGE,
      undefined,
      MID_CHAIN,
      async (payload) => {
        seen.push(payload);
      },
      [],
    );

    expect(runtime.fetched, "both tickers must be attempted").to.deep.equal(["BTC", "ETH"]);
    expect(result.success).to.equal(true);
    expect(result.data.isBillable, "one success is enough to report billable").to.equal(true);
    expect(result.data.tickers).to.deep.equal(["BTC", "ETH"]);

    // The counter and the raw-data map must stay in step: a ticker that returned nothing must not
    // leave a phantom entry behind, or a downstream consumer counting keys disagrees with the gate.
    expect(Object.keys(result.data.rawData)).to.deep.equal(["BTC"]);

    // Both halves reach the model: the resolved metrics AND the honest gap for the one that did
    // not. Dropping the gap would leave the model silently reasoning as if ETH were never asked
    // about. This is also what fails if the `continue` is hoisted above the append.
    expect(result.text).to.contain("INTERNAL LEDGER OBSERVATION: BTC");
    expect(result.text).to.contain(
      "I couldn't retrieve robust on-chain or sentiment data for ETH. It is either unsupported or lacks sufficient history.",
    );

    // core suppresses the interim callback for `source === "twitter"`; this body has no Twitter
    // path, so the branch always evaluates to core's non-Twitter behaviour and the callback fires.
    // Pinned because the allowance in pluginSenseaiScope rests on how this line EVALUATES here.
    expect(seen.map((p) => p.text)).to.include(
      "Extracting institutional-grade on-chain and sentiment data for BTC, ETH...",
    );
  });

  it("reports NON-BILLABLE when every ticker returns null", async () => {
    // The other side of the gate. On this body storing an answer IS charging for it —
    // EVMAIAgent.submitAnswer calls aiAgentEscrow.finalizePayment in the same transaction — so a
    // total ledger outage must not read as a paid answer.
    //
    // Note `success: true`. The action still answers; it just reports the turn as non-billable.
    // That is core's shape, and the two bodies must agree on it.
    const runtime = buildRuntime({
      extraction: { tickers: ["BTC", "ETH"] },
      ledger: { BTC: null, ETH: null },
    });

    const result = await action.handler(runtime, MESSAGE, undefined, MID_CHAIN, async () => {}, []);

    expect(result.success, "a total outage is still an answered turn").to.equal(true);
    expect(
      result.data.isBillable,
      "a zero-fetch run must REPORT non-billable — pin only, the oracle does not enforce it (CU-86d40gvmx)",
    ).to.equal(false);
    expect(Object.keys(result.data.rawData)).to.have.lengthOf(0);

    // The all-null branch replaces the observation wholesale rather than sending the model a
    // report made entirely of apologies.
    expect(result.text).to.equal(
      "I checked the institutional ledger, but I could not retrieve robust on-chain or sentiment data for the requested assets at this time.",
    );
    expect(result.text, "the per-ticker gaps must not leak into the fallback").to.not.contain(
      "INTERNAL LEDGER OBSERVATION",
    );
  });

  it("matches core on an outage: reports failure, does not synthesise, does not bill", async () => {
    // THE PARITY CASE, at the ACTION layer. core's SentimentService is a bare delegate, so an
    // engine throw reaches this action's catch — a catch that is byte-identical on both bodies —
    // and produces success:false with no observation and no synthesis.
    //
    // SCOPE, HONESTLY: this stub injects the throwing function AS the service, so it does not
    // exercise BrainService at all and passes whether or not that adapter swallows throws. What
    // it pins is the half core owns — given a throwing service, this action must answer exactly as
    // core's does. That the adapter actually propagates is pinned separately, in
    // `brainService.test.js` ("PROPAGATES an engine read failure"). Both halves are needed: this
    // one would still pass against an adapter that degraded, which is precisely the bug that was
    // here before.
    const runtime = buildRuntime({
      extraction: { tickers: ["BTC", "ETH"] },
      getAssetSentiment: async () => {
        throw new Error("connection refused");
      },
    });

    let callbackFired = false;
    const result = await action.handler(
      runtime,
      MESSAGE,
      undefined,
      MID_CHAIN,
      async () => {
        callbackFired = true;
      },
      [],
    );

    expect(result.success, "an outage is not an answered turn").to.equal(false);
    expect(result.data.isBillable, "core does not bill an outage, so neither may this").to.equal(
      false,
    );
    expect(result.error).to.contain("connection refused");
    expect(result.text, "no observation may be built from an outage").to.equal(undefined);
    // The interim "Extracting institutional-grade data for BTC, ETH..." callback fires BEFORE the
    // fetch loop, so it is expected even on the failure path — core does the same. What must not
    // happen is a synthesised report, and `result.text` being undefined is what shows it did not.
    expect(callbackFired, "core emits the interim callback before fetching too").to.equal(true);
  });

  it("reports NON-BILLABLE when the Brain service is unregistered", async () => {
    // Kept in core's position, before the try, so this early return is byte-for-byte core's: an
    // unregistered service is not a failed lookup and must never read as one.
    const runtime = buildRuntime({ noBrain: true, extraction: { tickers: ["BTC"] } });

    const result = await action.handler(runtime, MESSAGE, undefined, MID_CHAIN, async () => {}, []);

    expect(result.success).to.equal(false);
    expect(result.data.isBillable).to.equal(false);
    expect(result.error).to.equal("Sentiment service unavailable");
    expect(runtime.fetched, "nothing may be fetched without a service").to.have.lengthOf(0);
  });

  it("reports NON-BILLABLE when no ticker can be extracted", async () => {
    const runtime = buildRuntime({ extraction: { tickers: [] } });

    const result = await action.handler(
      runtime,
      { roomId: "room-1", content: { text: "how are things?" } },
      undefined,
      MID_CHAIN,
      async () => {},
      [],
    );

    expect(result.success).to.equal(false);
    expect(result.data.isBillable).to.equal(false);
    expect(result.text).to.contain("I couldn't identify which asset");
    expect(runtime.fetched, "no ticker means no ledger round-trip").to.have.lengthOf(0);
  });

  it("upper-cases and de-duplicates the extracted tickers before fetching", async () => {
    // One fetch per DISTINCT asset. Nothing bounds how many tickers the extraction returns
    // (tracked as CU-86d410r0z — a ceiling belongs in core so both bodies inherit it), which makes
    // the dedupe the only thing standing between a repetitive prompt and repeated serial
    // round-trips. Case-folding happens first, so "btc" and "BTC" collapse to one.
    const runtime = buildRuntime({
      extraction: { tickers: ["btc", "BTC", "eth"] },
      ledger: { BTC: METRICS, ETH: METRICS },
    });

    const result = await action.handler(runtime, MESSAGE, undefined, MID_CHAIN, async () => {}, []);

    expect(runtime.fetched, "a repeated ticker must not cost a second round-trip").to.deep.equal([
      "BTC",
      "ETH",
    ]);
    expect(result.data.tickers).to.deep.equal(["BTC", "ETH"]);
    expect(result.data.isBillable).to.equal(true);
  });
});
