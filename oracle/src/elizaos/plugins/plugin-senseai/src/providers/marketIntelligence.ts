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
 * The instruction block that tells the model what it may DO with the ticker. Byte-identical to
 * sense-ai-core's, and exported for the same reason as the heading: so a test asserts it rather
 * than a comment claiming it.
 */
export const NEWS_BLOCK_INSTRUCTIONS = `INSTRUCTIONS:
- This is a news article summary ticker.
- If the user asks for a deep dive, or asks about a specific topic/coin, execute the "GET_NEWS_DETAILS" action.`;

/**
 * Injects the enriched-news ticker into the agent's context — the oracle's half of the pair
 * sense-ai-core injects, rendered by the shared Brain's own `formatNewsTicker`.
 *
 * THIS FILE USED TO OMIT CORE'S INSTRUCTION BLOCK, and that omission was the bug.
 *
 * The reasoning behind it was sound at the time and is now void: `GET_NEWS_DETAILS` did not
 * exist on this body, so naming it would have invited a hallucinated tool call on the paid
 * on-chain path. It is registered now (see `../actions/getNewsDetails`), so the instruction
 * names a real action and the divergence has to go.
 *
 * WHAT THE OMISSION ACTUALLY COST, because it is not obvious. Both bodies inject byte-identical
 * news; core simply appended an `INSTRUCTIONS:` block naming the action and this one appended
 * nothing. The model therefore had ten fresh articles in front of it and no sanctioned way to
 * reach past the headlines — so it reached for `CALL_MCP_TOOL` instead, searched the CoinGecko
 * SDK documentation, and answered a news question with a TypeScript snippet.
 *
 * The control case is what makes this conclusive rather than plausible: the SAME run used the
 * macro block correctly, because macro's instruction ships INSIDE the Brain's
 * `formatMacroEnvironment` and so could not be dropped by a body. Injected context alone does
 * not get used; context plus a named action does.
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

      // Byte-identical to sense-ai-core's marketIntelligenceProvider — heading, instruction
      // block, and leading newline included. The two bodies must put the SAME news block in
      // front of the model, and every part of this string that was composed locally has already
      // drifted once: the heading read "(Warm Cache)" here against "(Local Ledger)" in core, and
      // the instruction block was missing entirely. Both are now exported constants asserted in
      // brainProviders.test.js, so the next edit has to be deliberate.
      //
      // The whole block belongs in the Brain's formatNewsTicker so drift is impossible rather
      // than merely tested — tracked as a follow-up, since it is a cross-repo change.
      return {
        text: `
${NEWS_BLOCK_HEADER}
${formatNewsTicker(latestNews as any)}

${NEWS_BLOCK_INSTRUCTIONS}
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
