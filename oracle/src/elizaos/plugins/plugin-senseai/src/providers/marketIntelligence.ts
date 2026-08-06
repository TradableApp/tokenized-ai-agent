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

  get: async (runtime: IAgentRuntime, _message: Memory, state?: State): Promise<ProviderResult> => {
    if (state?.values?.MARKET_INTELLIGENCE_INJECTED) return EMPTY;

    const brain = runtime.getService<BrainService>("brain");
    if (!brain) return EMPTY;

    try {
      const latestNews = await brain.getLatestNews(NEWS_LIMIT);
      if (!latestNews || latestNews.length === 0) return EMPTY;

      return {
        text: `
### SOVEREIGN MARKET INTELLIGENCE (Warm Cache)
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
