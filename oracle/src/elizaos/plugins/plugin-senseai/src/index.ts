import type { Plugin } from "@elizaos/core";

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
 * - **Analysis.** The old `getSentimentAction` returned hardcoded mock data AND was
 *   unreachable — its only caller was the Telegram menu-callback handler. So the Brain-backed
 *   replacement must be registered here as a FIRST-CLASS action, not behind a menu.
 *
 * The arrays below stay explicit rather than omitted: they are the seam where the Brain-backed
 * providers and analytical action land next, and where genuinely oracle-only capabilities go
 * later (on-chain answer shaping, TEE attestation surfaces, escrow-aware behaviour). Oracle-only
 * work that is NOT SenseAI analysis should be its own plugin alongside this one;
 * `oracle/test/pluginSenseaiScope.test.js` guards every plugin directory in the tree, so a new
 * plugin inherits the same rules instead of being exempt from the day it is created.
 */
const senseaiPlugin: Plugin = {
  name: "senseai",
  priority: 100,
  description:
    "SenseAI oracle body: a thin ElizaOS wrapper over the shared @tradableapp/sense-ai-brain analytical engine.",

  actions: [],
  // The Brain-backed pair sense-ai-core injects, from the same shared Brain so both bodies
  // see identical context. Oracle-only capabilities go here later; anything shared with the
  // Social body belongs in the Brain instead, so both get it.
  providers: [macroSentimentProvider, marketIntelligenceProvider],
  // Owns this body's read access to the shared warm cache — see services/brain.ts for why it
  // cannot derive a BrainContext from the runtime the way core does.
  services: [BrainService],
  evaluators: [],
};

export default senseaiPlugin;
