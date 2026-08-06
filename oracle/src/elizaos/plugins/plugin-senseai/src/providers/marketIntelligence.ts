import {
  elizaLogger,
  type IAgentRuntime,
  type Memory,
  type Provider,
  type ProviderResult,
  type State,
} from "@elizaos/core";
import { formatNewsTicker } from "@tradableapp/sense-ai-brain";

import type { BrainService } from "../services/brain";

const EMPTY: ProviderResult = { text: "", values: {}, data: {} };
const NEWS_LIMIT = 10;

/**
 * The news block's heading, byte-identical to sense-ai-core's marketIntelligenceProvider.
 *
 * Exported so a test can assert it rather than trusting a comment. Both bodies read the SAME
 * shared Postgres table through the SAME Brain formatter; the heading is the only part composed
 * locally, which made it the only part free to drift — and it had, to "(Warm Cache)" here
 * against "(Local Ledger)" in core.
 */
export const NEWS_BLOCK_HEADER = "### SOVEREIGN MARKET INTELLIGENCE (Local Ledger)";

/**
 * Injects the enriched-news ticker into the agent's context — the oracle's half of the pair
 * sense-ai-core injects, rendered by the shared Brain's own `formatNewsTicker`.
 *
 * ONE DELIBERATE DIVERGENCE FROM CORE. Core's version appends an instruction telling the model
 * to execute `GET_NEWS_DETAILS` for a deep dive. That action exists only in the Social body, and
 * it is explicitly a Social-body affordance. Repeating it here would instruct the oracle's LLM
 * to call an action that is not registered, inviting a hallucinated tool call on the ON-CHAIN
 * answer path — where the failure reaches a user who has already paid for the prompt, rather
 * than a chat window where they can simply ask again. The ticker is injected as context only.
 *
 * Turn-state dedup mirrors core: composeState may invoke providers more than once per turn, and
 * repeating the ticker burns context window that the oracle's answer needs.
 */
export const marketIntelligenceProvider: Provider = {
  name: "MARKET_INTELLIGENCE",
  // Explicit, and it changes behaviour rather than merely documenting it: composeState sorts by
  // `(a.position || 0) - (b.position || 0)`, so a provider WITHOUT a position sorts to 0 — ahead
  // of MACRO_SENTIMENT (50). The news ticker was therefore rendering BEFORE the macro framing it
  // is meant to sit under. sense-ai-core leaves this unset and has the same inversion; that is
  // tracked as a follow-up, since the two bodies must order identically to compose identical
  // context.
  position: 51,

  get: async (runtime: IAgentRuntime, _message: Memory, state?: State): Promise<ProviderResult> => {
    if (state?.values?.MARKET_INTELLIGENCE_INJECTED) return EMPTY;

    const brain = runtime.getService<BrainService>("brain");
    if (!brain) return EMPTY;

    try {
      const latestNews = await brain.getLatestNews(NEWS_LIMIT);
      if (!latestNews || latestNews.length === 0) return EMPTY;

      // Byte-identical to sense-ai-core's marketIntelligenceProvider, heading and leading
      // newline included — the two bodies must put the SAME news block in front of the model.
      // It read "(Warm Cache)" here and "(Local Ledger)" in core: same shared Postgres table,
      // two names, and a silent divergence in the LLM-facing text. Core's wording wins because
      // it is the one already deployed; NEWS_BLOCK_HEADER is asserted in brainProviders.test.js
      // so the next edit has to be deliberate.
      //
      // The heading belongs in the Brain's formatNewsTicker so drift is impossible rather than
      // merely tested — tracked as a follow-up, since it is a cross-repo change.
      //
      // What deliberately does NOT match: core appends a GET_NEWS_DETAILS instruction. That
      // action is a Social-body affordance the oracle does not register, and telling a model to
      // invoke an action that does not exist invites a hallucinated tool call.
      return {
        text: `
${NEWS_BLOCK_HEADER}
${formatNewsTicker(latestNews as any)}
`,
        values: { MARKET_INTELLIGENCE_INJECTED: true },
        data: { latestNews },
      };
    } catch (error) {
      elizaLogger.error(
        `[MarketIntelligence] Error building news context: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return EMPTY;
    }
  },
};
