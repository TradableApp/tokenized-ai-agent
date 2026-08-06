const path = require("node:path");

const { expect } = require("chai");

// Brain-backed ElizaOS providers for the oracle — CU-86d3ud1va (epic CU-86d3dwme6), part 2.
//
// WHY PROVIDERS AT ALL. Today the oracle string-concatenates market context onto the user's
// message in aiAgentOracle.js:
//
//     text: `${currentMessage.content}\n\n[MARKET CONTEXT — …]\n${marketContext.contextText}`
//
// That is prompt injection done by hand, bypassing the composition ElizaOS exists to do.
// Providers are the framework's own seam for "add this to the agent's context", and using them
// is what makes the two bodies structurally equal rather than merely fed the same data —
// sense-ai-core already injects the identical blocks via MACRO_SENTIMENT and MARKET_INTELLIGENCE.
//
// WHY A SERVICE HOLDS THE BRAIN, rather than createBrainContext(runtime) as core does. Core's
// plugin-sql is wired to the SHARED senseai database, so its providers can build a BrainContext
// straight from the runtime. This oracle deliberately runs an ISOLATED agent DB (oracle_agent —
// see wireAgentDb), so a runtime-derived context would read the wrong database entirely and
// return no warm-cache data while looking healthy. The Brain handles therefore live in a
// service that owns its own connection to the shared cache, and providers reach them the
// ElizaOS way: runtime.getService(...).
//
// WHAT MUST NOT REGRESS. getMarketContext() returns TWO things today, and only the first is
// prompt injection:
//   1. contextText — concatenated onto the message (this is what providers replace)
//   2. sources     — attached to the answer MessageFile and RENDERED BY THE dApp
// sources[] is a shipped feature with e2e coverage (sense-ai-dapp T-REASON-01 asserts both
// sources' hrefs round-trip). Providers inject into composition and do not hand data back to
// queryElizaOS, so moving context to providers must not quietly drop it. That migration is the
// next increment; this one adds the service + macro provider without touching the answer path.

const DIST = path.resolve(
  __dirname,
  "../src/elizaos/plugins/plugin-senseai/dist/index.js",
);

/** Minimal ElizaOS runtime stub: providers only ever call getService here. */
function runtimeWith(services = {}) {
  return { getService: name => services[name] ?? null };
}

describe("oracle Brain providers", () => {
  let plugin;

  before(() => {
    // Requires the built plugin, which is how aiAgentOracle.js:20 consumes it. A missing dist
    // means the plugin was not built — fail with that, not with a confusing undefined later.
    try {
      plugin = require(DIST).default;
    } catch (err) {
      throw new Error(
        `Could not load the built plugin at ${DIST}. Build it first ` +
          `(cd oracle/src/elizaos/plugins/plugin-senseai && bun run build). Underlying: ${err.message}`,
      );
    }
  });

  describe("registration", () => {
    it("registers the Brain service so providers can reach the shared warm cache", () => {
      const names = (plugin.services ?? []).map(s => s.serviceType ?? s.name);
      expect(
        names,
        "the oracle's Brain handles must be exposed as an ElizaOS service — providers resolve " +
          "them via runtime.getService, and the service owns the connection to the SHARED cache " +
          "rather than the isolated oracle_agent DB",
      ).to.include("brain");
    });

    it("registers the macro provider", () => {
      const names = (plugin.providers ?? []).map(p => p.name);
      expect(names).to.include("MACRO_SENTIMENT");
    });
  });

  describe("MACRO_SENTIMENT provider", () => {
    const macro = () => plugin.providers.find(p => p.name === "MACRO_SENTIMENT");

    it("returns the Brain's formatted macro block, not its own formatting", async () => {
      // Byte-identical context across both bodies is the whole point of the shared Brain: the
      // oracle must render via the Brain's formatter, never reimplement the block.
      const macroState = { fearGreedClassification: "Greed", btcDominance: 54.2 };
      const result = await macro().get(
        runtimeWith({ brain: { getLatestMacro: async () => macroState } }),
        {},
        {},
      );

      expect(result.text, "expected a non-empty macro block").to.be.a("string").and.not.equal("");
      expect(result.data.macroState).to.deep.equal(macroState);
      expect(result.values.macroState).to.equal("Greed");
    });

    it("returns empty context when the service is absent, rather than throwing", async () => {
      // A provider that throws fails composeState for the WHOLE turn, so an unconfigured Brain
      // would take down the answer path. Localnet e2e runs with no Cloud SQL at all.
      const result = await macro().get(runtimeWith({}), {}, {});
      expect(result).to.deep.equal({ text: "", values: {}, data: {} });
    });

    it("returns empty context when the warm cache has no macro row", async () => {
      const result = await macro().get(
        runtimeWith({ brain: { getLatestMacro: async () => null } }),
        {},
        {},
      );
      expect(result).to.deep.equal({ text: "", values: {}, data: {} });
    });

    it("degrades to empty context when the Brain read throws", async () => {
      const result = await macro().get(
        runtimeWith({
          brain: {
            getLatestMacro: async () => {
              throw new Error("connection reset");
            },
          },
        }),
        {},
        {},
      );
      expect(
        result,
        "a DB blip must never fail the turn — the oracle answers without context instead",
      ).to.deep.equal({ text: "", values: {}, data: {} });
    });

    it("carries no Social-body affordances in its context text", async () => {
      // core's MARKET_INTELLIGENCE appends a GET_NEWS_DETAILS action instruction, which is
      // explicitly a Social-body affordance. Telling the oracle's LLM to run an action that is
      // not registered here invites a hallucinated tool call on the on-chain answer path.
      const result = await macro().get(
        runtimeWith({ brain: { getLatestMacro: async () => ({ fearGreedClassification: "Fear" }) } }),
        {},
        {},
      );
      expect(result.text).to.not.match(/GET_NEWS_DETAILS|Telegram|launch the app/i);
    });
  });
});
