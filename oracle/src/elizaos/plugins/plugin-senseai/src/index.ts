import type { Plugin } from "@elizaos/core";

import { analyzeAssetSentimentAction } from "./actions/analyzeAssetSentiment";
import { getNewsDetailsAction } from "./actions/getNewsDetails";
import { macroSentimentProvider } from "./providers/macroSentiment";
import { marketIntelligenceProvider } from "./providers/marketIntelligence";
import { BrainService } from "./services/brain";

// Host injection seam: the oracle owns the Brain connection (mTLS certs, drizzle, timeouts)
// and hands this plugin a getter for the handles. See services/brain.ts for why.
export { setBrainAccessor } from "./services/brain";
export type { BrainAccessor } from "./services/brain";

/**
 * SenseAI — the ORACLE body's ElizaOS plugin.
 *
 * Architecture ("one Brain, two bodies"): ElizaOS is the harness and this plugin is a thin
 * wrapper; the analysis itself comes from `@tradableapp/sense-ai-brain`, shared with the
 * Social body (`sense-ai-core`). The two bodies differ only in delivery — sense-ai-core adds
 * its Telegram and X plugins, this one answers on-chain prompts. Anything analytical belongs
 * in the Brain so both bodies get it; anything Telegram/X belongs in sense-ai-core.
 *
 * This file is currently a registration shell. It was a COPY of sense-ai-core's plugin that
 * drifted, and every one of its ~2,400 lines was Telegram-coupled and therefore inert here:
 * five Telegram UX actions, an accessProvider that early-returned on `source !== "telegram"`,
 * an in-memory Telegram rate limiter, a usageTracker evaluator gated the same way, and an
 * `init` that called `bot.telegram.setMyDescription` on a service the TEE does not run.
 * Removing it changed no behaviour on the answer path — none of it could execute.
 *
 * Two things that removal did NOT cost, worth stating so they are not "restored" by mistake:
 *
 * - **Access control.** The oracle is $ABLE/escrow-bounded, enforced on-chain by
 *   `EVMAIAgentEscrow` before a prompt is ever emitted. It was never the plugin's job, and
 *   the deleted accessProvider was a Telegram quota gate, not an escrow gate.
 * - **accessProvider's INSTRUCTIONS, not just its gating.** Re-audited 2026-08-20, because
 *   "it only gated access" is the easy reading and it is incomplete: the provider also
 *   injects behavioural directives, including a literal `You MUST execute the
 *   "CALL_MCP_TOOL" action now`. Losing that would matter — it is the same action that
 *   produced the fenced-TypeScript answer. It does not, because every directive is gated on
 *   an input shape this body cannot receive: the MCP ones fire only on Telegram button
 *   callbacks (`action:get_btc_price`, `action:market_overview`), the menu ones on a menu
 *   keyword, `ORGANIC INTERJECTION` on the TG eavesdropper's server-set `isOrganic` flag,
 *   and the persona block on `source === "twitter"`. Core's own comment is explicit that
 *   "Free-text messages NEVER reach this branch". On the free-text path — the oracle's ONLY
 *   input, an `encryptedPayload` validated by `payloadValidator.js` — the provider returns
 *   rate-limit bookkeeping plus "Proceed with answering the user's current query." Nothing
 *   behavioural is lost, and re-adding the provider to carry that one content-free sentence
 *   would invent divergence rather than remove it.
 * - **Analysis.** The old `getSentimentAction` returned hardcoded mock data AND was
 *   unreachable — its only caller was the Telegram menu-callback handler. So the Brain-backed
 *   replacement must be registered here as a FIRST-CLASS action, not behind a menu.
 *
 * The arrays below stay explicit rather than omitted: they are the seam where the Brain-backed
 * providers and analytical actions land, and where genuinely oracle-only capabilities go later
 * (on-chain answer shaping, TEE attestation surfaces, escrow-aware behaviour). Oracle-only
 * work that is NOT SenseAI analysis should be its own plugin alongside this one;
 * `oracle/test/pluginSenseaiScope.test.js` guards every plugin directory in the tree, so a new
 * plugin inherits the same rules instead of being exempt from the day it is created.
 *
 * GET_NEWS_DETAILS is the first entry in `actions`, and registering it is what makes the news
 * ticker actionable. Both bodies inject byte-identical news context, but only core named a way
 * to act on it; deprived of a sanctioned path, this body's model reached for CALL_MCP_TOOL and
 * answered a news question with TypeScript from the CoinGecko SDK docs. The action and the
 * provider instruction that points at it are one change, not two — see
 * `providers/marketIntelligence.ts`.
 */
const senseaiPlugin: Plugin = {
  name: "senseai",
  priority: 100,
  description:
    "SenseAI oracle body: a thin ElizaOS wrapper over the shared @tradableapp/sense-ai-brain analytical engine.",

  // The analytical actions sense-ai-core registers, ported near-verbatim so a question is
  // answered the same way on both bodies. Anything Telegram/X-shaped stays in core.
  //
  // ANALYZE_ASSET_SENTIMENT deliberately has NO provider instruction pointing at it, and that is
  // not the omission GET_NEWS_DETAILS suffered from. Core has none either: the action is selected
  // from its own `similes` and `examples` ("what is the outlook on", "is it a good time to buy"),
  // which is how ElizaOS is meant to route. The news case was different because
  // MARKET_INTELLIGENCE injects a ticker of headlines the model can see but was never told it
  // could act on — context without an affordance. There is no equivalent standing sentiment
  // block, so there is nothing to point at.
  //
  // NOT PORTED: ANALYZE_FINANCIAL_IMAGE — recorded here rather than only in a plan, because
  // "every non-social capability is ported or has a recorded reason for omission" is an
  // acceptance criterion, and a reason nobody can find at the call site is not recorded.
  //
  // The analysis is genuinely analytical and would belong in the Brain. The INTAKE does not
  // exist: core's action is fed by a Telegram photo upload, and this body's only input is the
  // `encryptedPayload` of a `PromptSubmitted` event — text, validated by Zod in
  // `payloadValidator.js`. There is no dApp affordance for attaching an image either. Porting
  // the action would register a capability the model could select and then never satisfy, on a
  // prompt that has already been paid for.
  //
  // If an image intake is ever added, this is a port and not a rewrite: the vision prompt and
  // parsing move to the Brain first (both bodies), the action is copied here as the other two
  // were, and its name joins SYNTHESIS_ACTIONS in `oracle/src/answerSelection.js` in the SAME
  // commit — `oracle/test/synthesisActions.test.js` enforces that pairing in both directions.
  actions: [getNewsDetailsAction, analyzeAssetSentimentAction],
  // The Brain-backed pair sense-ai-core injects, from the same shared Brain so both bodies
  // see identical context. Oracle-only capabilities go here later; anything shared with the
  // Social body belongs in the Brain instead, so both get it.
  providers: [macroSentimentProvider, marketIntelligenceProvider],
  // Owns this body's read access to the shared warm cache — see services/brain.ts for why it
  // cannot derive a BrainContext from the runtime the way core does.
  //
  // NOT PORTED: healthCheckService / dailySummaryService — DEFERRED, not rejected, and the
  // distinction matters because the reasoning differs from every other omission here.
  //
  // They are not social FEATURES; they are ops telemetry that happens to be delivered over
  // Slack, and an on-chain oracle answering paid prompts inside a TEE arguably needs that
  // visibility MORE than the Social body does — `oasis rofl machine logs` surfaces only warn and
  // error, so a healthy oracle is currently indistinguishable from a silent one. What stops the
  // port today is shape, not scope: both read the shared `senseai` tables and build a Slack
  // payload, so the query half belongs in the Brain (like every other shared read) and only the
  // scheduling and the reporter identity stay per body. Copying them here first would fork the
  // query half, which is the drift the shared Brain exists to prevent.
  //
  // Sequenced behind `recordActivity` (CU-86d3z0r81, PR C3) deliberately: the summary reports on
  // the `daily_activity` table this body does not yet write to, so porting the reporter before
  // the recorder would ship a summary that reports the oracle as idle.
  //
  // Now tracked as CU-86d438hwt — a deferral recorded only in a comment is a deferral that
  // gets forgotten.
  //
  // NOT PORTED: a `messageHandlerTemplate` override — and this one is recorded because the
  // CU-86d3z0r81 description ASKS for it, so the next reader will otherwise go looking.
  //
  // That description says core "prevents this with `utils/actionChainHelper.ts` plus a
  // `messageHandlerTemplate` override that constrains the action-selection pass". Verified
  // 2026-08-20: no such override exists on core's answer path. Core's ONLY
  // `messageHandlerTemplate` is in `plugin-twitter-senseai/src/interactions.ts`, and it is an
  // X reply-style template ("{{agentName}} is replying to you", no URLs, no hashtags, under
  // 240 chars) — delivery styling, not action selection, and `plugin-twitter-senseai` is on
  // the SKIP list. Core's Telegram and senseai paths use the ElizaOS DEFAULT template, so
  // parity means this body uses it too. Porting the X template would CREATE divergence.
  //
  // The fenced-TypeScript failure was never caused by the template. Core registers the same
  // `@elizaos/plugin-mcp` against the same CoinGecko server and does not produce it, because
  // core had a sanctioned action for the question and this body did not: deprived of one, the
  // model reached for `CALL_MCP_TOOL`. Both halves of the real fix are in place —
  // GET_NEWS_DETAILS registered above, and `handleChainSynthesis` keeping raw action output
  // out of the answer. The behavioural guard against a regression is `answerQuality.js`,
  // which fails the smoke on a code-fenced or apology-shaped answer; being behavioural, it
  // survives an ElizaOS upgrade changing its default template, which a copied override
  // would not.
  services: [BrainService],
  evaluators: [],
};

export default senseaiPlugin;
