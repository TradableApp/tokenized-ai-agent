const { expect } = require("chai");

const { sourcesFromState, reasoningFromThoughts } = require("../src/answerProvenance");

// Answer provenance — CU-86d3ud1va, part 2.
//
// WHAT THIS REPLACES. Today aiAgentOracle.js takes `sources` from a list the ORACLE fetched
// itself before the run:
//
//     sources: news.filter(n => n.title && n.url).map(n => ({ title: n.title, url: n.url }))
//
// i.e. everything that was injected, whether the answer drew on it or not — while the dApp
// renders "Used N sources" over it. That is an accuracy problem in a product selling verifiable
// analysis, and once context moves to providers the oracle no longer holds that list anyway.
//
// WHERE IT COMES FROM INSTEAD. ElizaOS caches provider results on composed state:
// `StateData.providers?: Record<string, Record<string, unknown>>` — "Provider results cache
// keyed by provider name" — and `runtime.composeState(message, includeList, onlyInclude)` is
// public API the oracle can already reach via `elizaOS.getAgent(...)`. So provenance is derived
// from what the run ACTUALLY composed, through the framework's own seam rather than a side
// channel. (`handleMessage` returns only { messageId, userMessage, processing } — no state —
// which is why composeState is the carrier.)
//
// CONTRACT. These shapes are consumed downstream: formatters.js writes them into the encrypted
// MessageFile, and the dApp spreads that into its message (syncService `...messageData`) where
// types.ts declares `sources?: Array<{title, url}>` and
// `reasoning?: Array<{title, description}>`. e2e T-REASON-01 asserts both sources' hrefs
// round-trip. Neither is on-chain and neither is in the subgraph, so the shape is an
// oracle<->dApp contract — changing it means changing both together.

describe("answer provenance", () => {
  describe("sourcesFromState", () => {
    // Mirrors what ElizaOS ACTUALLY produces, not what is convenient to parse. composeState
    // stores each provider's whole result — `{ ...result, providerName }` — under
    // state.data.providers[name], so the payload sits under `.data`. Writing the stub from the
    // real shape is the point: the previous version matched the parser's assumption instead,
    // which made the tests circular and hid a parser that returned [] on every live answer.
    const stateWith = news => ({
      values: {},
      data: {
        providers: {
          MARKET_INTELLIGENCE: {
            text: "### SOVEREIGN MARKET INTELLIGENCE …",
            values: { MARKET_INTELLIGENCE_INJECTED: true },
            data: { latestNews: news },
            providerName: "MARKET_INTELLIGENCE",
          },
        },
      },
      text: "",
    });

    it("derives sources from what the run composed", () => {
      const sources = sourcesFromState(
        stateWith([
          { title: "BTC ETF inflows accelerate", url: "https://example.test/a" },
          { title: "ETH staking yield dips", url: "https://example.test/b" },
        ]),
      );
      expect(sources).to.deep.equal([
        { title: "BTC ETF inflows accelerate", url: "https://example.test/a" },
        { title: "ETH staking yield dips", url: "https://example.test/b" },
      ]);
    });

    it("drops entries missing a title or url", () => {
      // Preserves today's behaviour: the dApp renders these as links, so an entry without a
      // usable href is not a source — it is a broken row.
      const sources = sourcesFromState(
        stateWith([
          { title: "Good", url: "https://example.test/a" },
          { title: "No url" },
          { url: "https://example.test/c" },
          { title: "", url: "https://example.test/d" },
        ]),
      );
      expect(sources).to.deep.equal([{ title: "Good", url: "https://example.test/a" }]);
    });

    it("de-duplicates by url, keeping the first occurrence", () => {
      // Adjacent adapters can surface the same article; the same link listed twice reads as a
      // padded citation count to a user paying per prompt.
      const sources = sourcesFromState(
        stateWith([
          { title: "First wording", url: "https://example.test/same" },
          { title: "Second wording", url: "https://example.test/same" },
        ]),
      );
      expect(sources).to.deep.equal([{ title: "First wording", url: "https://example.test/same" }]);
    });

    it("returns [] for missing, empty or malformed state rather than throwing", () => {
      // Provenance must never be the thing that fails an answer the user has paid for.
      for (const [label, input] of [
        ["undefined", undefined],
        ["null", null],
        ["no data", { values: {} }],
        ["no providers", { values: {}, data: {} }],
        ["provider absent", { values: {}, data: { providers: {} } }],
        ["latestNews not an array", stateWith("nope")],
        ["payload not nested under .data", { values: {}, data: { providers: { MARKET_INTELLIGENCE: { latestNews: [{ title: "t", url: "u" }] } } } }],
        ["latestNews missing", { values: {}, data: { providers: { MARKET_INTELLIGENCE: { data: {} } } } }],
      ]) {
        expect(sourcesFromState(input), `${label} should yield []`).to.deep.equal([]);
      }
    });
  });

  describe("reasoningFromThoughts", () => {
    it("titles each step by the action that produced it", () => {
      // "Step 1/2/3" carries no information. The action name is what actually happened, and it
      // is what makes the dApp's reasoning disclosure worth expanding.
      const steps = reasoningFromThoughts([
        { thought: "Checking the warm cache for SOL", action: "GET_ASSET_SENTIMENT" },
        { thought: "Cache miss — fetching fresh metrics", action: "GET_ASSET_SENTIMENT" },
      ]);
      expect(steps).to.deep.equal([
        { title: "GET_ASSET_SENTIMENT", description: "Checking the warm cache for SOL" },
        { title: "GET_ASSET_SENTIMENT", description: "Cache miss — fetching fresh metrics" },
      ]);
    });

    it("falls back to a numbered step when no action is attributed", () => {
      // Not every thought comes from an action, and a missing attribution must not lose the
      // thought itself.
      const steps = reasoningFromThoughts([{ thought: "Weighing the macro backdrop" }]);
      expect(steps).to.deep.equal([
        { title: "Step 1", description: "Weighing the macro backdrop" },
      ]);
    });

    it("accepts bare strings, matching what the runtime emits today", () => {
      // aiAgentOracle currently pushes `content.thought` (a string) — the helper must keep
      // working during the migration rather than requiring every call site to change at once.
      expect(reasoningFromThoughts(["Plain thought"])).to.deep.equal([
        { title: "Step 1", description: "Plain thought" },
      ]);
    });

    it("drops empty thoughts and returns [] for missing input", () => {
      expect(reasoningFromThoughts([{ thought: "   " }, { thought: "" }, {}])).to.deep.equal([]);
      expect(reasoningFromThoughts(undefined)).to.deep.equal([]);
      expect(reasoningFromThoughts("not an array")).to.deep.equal([]);
    });
  });
});
