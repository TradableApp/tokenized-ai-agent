import {
  elizaLogger,
  type IAgentRuntime,
  type Memory,
  type Provider,
  type ProviderResult,
  type State,
} from "@elizaos/core";
import { formatMacroEnvironment } from "@tradableapp/sense-ai-brain";

import type { BrainService } from "../services/brain";

const EMPTY: ProviderResult = { text: "", values: {}, data: {} };

/**
 * Injects the global macro environment (Fear & Greed, dominance, M2, ETF flows) into the
 * agent's context — the oracle's half of the pair sense-ai-core injects.
 *
 * The block is rendered by the shared Brain's own `formatMacroEnvironment`, never
 * reimplemented here: byte-identical LLM-facing context on both bodies is the whole point of
 * having one Brain. Only the data source differs — core reads through a runtime-derived
 * BrainContext, the oracle through its BrainService, because its runtime database is the
 * isolated `oracle_agent` one rather than the shared cache.
 */
export const macroSentimentProvider: Provider = {
  name: "MACRO_SENTIMENT",
  position: 50,

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<ProviderResult> => {
    const brain = runtime.getService<BrainService>("brain");
    if (!brain) return EMPTY;

    try {
      const macroState = await brain.getLatestMacro();
      if (!macroState) return EMPTY;

      return {
        text: formatMacroEnvironment(macroState),
        values: { macroState: macroState.fearGreedClassification },
        data: { macroState },
      };
    } catch (error) {
      // Swallowed deliberately: a provider that throws fails composeState for the entire turn,
      // so a database blip would cost the user their answer rather than just its context.
      elizaLogger.error(
        `[MacroSentiment] Error fetching macro state: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return EMPTY;
    }
  },
};
