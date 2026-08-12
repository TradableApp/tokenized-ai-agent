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

    it("registers the same Brain-backed provider pair as sense-ai-core", () => {
      // Parity is the goal: core injects MACRO_SENTIMENT + MARKET_INTELLIGENCE, and the oracle
      // must inject the same pair from the same Brain so both bodies see identical context.
      const names = (plugin.providers ?? []).map(p => p.name);
      expect(names).to.include("MACRO_SENTIMENT");
      expect(names).to.include("MARKET_INTELLIGENCE");
    });
  });

  describe("MACRO_SENTIMENT provider", () => {
    const macro = () => plugin.providers.find(p => p.name === "MACRO_SENTIMENT");

    it("returns the Brain's formatted macro block, not its own formatting", async () => {
      // Byte-identical context across both bodies is the whole point of the shared Brain: the
      // oracle must render via the Brain's formatter, never reimplement the block.
      // Realistic GlobalMacroData: the Brain's formatter reads several numeric fields and calls
      // .toFixed() on them, so a thin fixture would render "$NaN" and still pass a non-empty
      // assertion — proving nothing.
      const macroState = {
        fearGreedIndex: 72,
        fearGreedClassification: "Greed",
        btcDominance: 54.2,
        ethDominance: 17.8,
        moneySupply: 21500,
        dailyEtfFlow: 412000000,
        trendingWords: ["etf", "halving"],
      };
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
        runtimeWith({
          brain: {
            getLatestMacro: async () => ({
              fearGreedIndex: 20,
              fearGreedClassification: "Fear",
              btcDominance: 51,
              ethDominance: 16,
              moneySupply: 21000,
              dailyEtfFlow: 0,
              trendingWords: [],
            }),
          },
        }),
        {},
        {},
      );
      expect(result.text).to.not.match(/GET_NEWS_DETAILS|Telegram|launch the app/i);
    });
  });

  describe("MARKET_INTELLIGENCE provider", () => {
    const news = () => plugin.providers.find(p => p.name === "MARKET_INTELLIGENCE");
    const rows = [
      { title: "BTC ETF inflows accelerate", url: "https://example.test/a", source: "CoinDesk" },
      { title: "ETH staking yield dips", url: "https://example.test/b", source: "CryptoPanic" },
    ];

    it("returns the Brain's formatted news ticker", async () => {
      const result = await news().get(
        runtimeWith({ brain: { getLatestNews: async () => rows } }),
        {},
        {},
      );
      expect(result.text).to.be.a("string").and.not.equal("");
      expect(result.data.latestNews).to.deep.equal(rows);
    });

    it("heads the block with the exact wording sense-ai-core uses", async () => {
      // The heading is the ONLY part of this block composed locally — the rows come from the
      // Brain's own formatNewsTicker — so it was the only part free to drift, and it had:
      // "(Warm Cache)" here against "(Local Ledger)" in core, for the same shared Postgres table.
      // Two bodies claiming a shared Brain must put the same text in front of the model.
      //
      // Hard-coded rather than derived: this test's job is to fail when someone edits the
      // constant, so reading the constant to check itself would prove nothing. The value is
      // copied from sense-ai-core/src/plugins/plugin-senseai/src/providers/marketIntelligence.ts.
      const CORE_HEADER = "### SOVEREIGN MARKET INTELLIGENCE (Local Ledger)";

      const result = await news().get(
        runtimeWith({ brain: { getLatestNews: async () => rows } }),
        {},
        {},
      );

      // Leading newline included: core's template literal opens the same way, so trimming here
      // would be a divergence dressed up as tidiness.
      expect(result.text.startsWith(`\n${CORE_HEADER}\n`), result.text.slice(0, 80)).to.equal(true);
    });

    it("carries the GET_NEWS_DETAILS instruction, exactly as sense-ai-core does", async () => {
      // THIS TEST USED TO ASSERT THE OPPOSITE, and the inversion is the fix.
      //
      // The old rule ("omit it — that action is Social-body only") was correct while
      // GET_NEWS_DETAILS was unregistered here: naming a non-existent action would invite a
      // hallucinated tool call on the paid on-chain path. The action is registered now, so the
      // premise is gone and the omission became the bug.
      //
      // What it cost: both bodies inject byte-identical news, but only core named a way to act
      // on it. Given ten fresh articles and no sanctioned path past the headlines, this body's
      // model reached for CALL_MCP_TOOL, searched the CoinGecko SDK docs, and answered a news
      // question with a TypeScript snippet. The control case is that the same run used the macro
      // block correctly — macro's instruction ships INSIDE the Brain's formatMacroEnvironment,
      // so no body could drop it.
      //
      // Hard-coded rather than imported from the provider, for the same reason as the heading
      // above: a test that reads the constant it is checking proves nothing. Copied from
      // sense-ai-core/src/plugins/plugin-senseai/src/providers/marketIntelligence.ts.
      const CORE_INSTRUCTIONS =
        "INSTRUCTIONS:\n" +
        "- This is a news article summary ticker.\n" +
        "- If the user asks for a deep dive, or asks about a specific topic/coin, execute the " +
        '"GET_NEWS_DETAILS" action.';

      const result = await news().get(
        runtimeWith({ brain: { getLatestNews: async () => rows } }),
        {},
        {},
      );

      expect(result.text).to.contain(CORE_INSTRUCTIONS);
      // Trailing newline included: core's template literal closes the same way.
      expect(result.text.endsWith(`${CORE_INSTRUCTIONS}\n`), result.text.slice(-120)).to.equal(
        true,
      );
    });

    it("names only actions this body actually registers", async () => {
      // The generalised form of the rule the inverted test above used to enforce. The old rule
      // was a proxy for this one and stopped being a good proxy the moment the action landed;
      // this checks the property that actually matters, so it keeps holding as more actions are
      // ported instead of having to be inverted again.
      // EVERY provider, not just this one. Scoping it to MARKET_INTELLIGENCE would have left the
      // hole half-open: MACRO_SENTIMENT's text comes from the Brain's formatMacroEnvironment,
      // which is shared with core, so a future core-driven change there could name a Social-body
      // action and land here silently — the same failure this test exists to prevent, arriving
      // by a route the narrow version could not see.
      const registered = new Set((plugin.actions || []).map(a => a.name));
      const macroRow = {
        fearGreedIndex: 20,
        fearGreedClassification: "Fear",
        btcDominance: 51,
        ethDominance: 16,
        moneySupply: 21000,
        dailyEtfFlow: 0,
        trendingWords: [],
      };
      const runtime = runtimeWith({
        brain: { getLatestNews: async () => rows, getLatestMacro: async () => macroRow },
      });

      let inspected = 0;
      for (const provider of plugin.providers || []) {
        // Fresh empty state per provider so turn-dedup does not blank the second one.
        const result = await provider.get(runtime, {}, {});

        // A scan over empty text passes trivially and proves nothing — the loop would report
        // green while inspecting no context at all. Assert there was something to inspect.
        expect(
          (result.text || "").trim(),
          `${provider.name} produced no context, so this guard scanned nothing — fix the stub`,
        ).to.not.equal("");
        inspected += 1;

        // ANCHORED ON THE IMPERATIVE, not on "any quoted ALLCAPS token".
        //
        // The first version matched /"([A-Z][A-Z0-9_]{3,})"/, which is any 4+ character quoted
        // all-caps string anywhere in the context. Two of the three blocks scanned here are
        // rendered by Brain formatters living in ANOTHER REPO, so the day one of them quotes a
        // sentiment label or classification — "BULLISH", "FEAR" — this guard fails claiming a
        // non-existent action, and the failure blames the wrong thing entirely.
        //
        // Matching `execute the "X" action` instead keys on the construct that actually creates
        // the hazard: an instruction telling the model to RUN something. A quoted noun elsewhere
        // in the context is not a tool call and was never this test's business.
        //
        // Relying on that phrasing is safe because it cannot drift silently: the instruction
        // block is pinned byte-for-byte by `carries the GET_NEWS_DETAILS instruction, exactly as
        // sense-ai-core does` above. Reword the instruction and that test fails first, which is
        // the signal to update this pattern too.
        const IMPERATIVE = /execute the "([A-Z][A-Z0-9_]{3,})" action/g;
        for (const [, name] of (result.text || "").matchAll(IMPERATIVE)) {
          expect(
            registered.has(name),
            `${provider.name} tells the model to execute "${name}", but this body registers no ` +
              "such action — it can only hallucinate a tool call, on the paid on-chain path",
          ).to.equal(true);
        }
      }

      // Derived, not hardcoded. A literal `2` here fails a third provider with
      // "expected 3 to equal 2" alongside a message insisting two is correct — which sends the
      // reader looking for a deleted provider instead of at the loop that skipped one. The point
      // of this assertion is "every registered provider was inspected", so say that.
      expect(
        inspected,
        "every Brain-backed provider must be inspected, not just the ones the loop happened to reach",
      ).to.equal((plugin.providers || []).length);
    });

    it("does not re-inject when the turn already has it", async () => {
      // Mirrors core's turn-state dedup: composeState may call providers more than once per
      // turn, and duplicating the ticker wastes context window on the oracle's answer path.
      const result = await news().get(
        runtimeWith({ brain: { getLatestNews: async () => rows } }),
        {},
        { values: { MARKET_INTELLIGENCE_INJECTED: true } },
      );
      expect(result).to.deep.equal({ text: "", values: {}, data: {} });
    });

    it("returns empty context when the service is absent, the cache is empty, or the read throws", async () => {
      const absent = await news().get(runtimeWith({}), {}, {});
      const empty = await news().get(
        runtimeWith({ brain: { getLatestNews: async () => [] } }),
        {},
        {},
      );
      const threw = await news().get(
        runtimeWith({
          brain: {
            getLatestNews: async () => {
              throw new Error("connection reset");
            },
          },
        }),
        {},
        {},
      );
      for (const [label, r] of [["absent", absent], ["empty", empty], ["threw", threw]]) {
        expect(r, `${label} must degrade to empty context, never fail the turn`).to.deep.equal({
          text: "",
          values: {},
          data: {},
        });
      }
    });
  });
});
