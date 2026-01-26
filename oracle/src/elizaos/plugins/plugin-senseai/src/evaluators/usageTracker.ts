import {
  Evaluator,
  IAgentRuntime,
  Memory,
  elizaLogger,
  ActionResult,
} from "@elizaos/core";
import { RateLimitService } from "../services/rateLimit";

/**
 * Runs after a message is successfully processed and replied to.
 * It decrements the user's free message count if they are on Telegram.
 * This ensures users are only "charged" for successful interactions.
 */
export const usageTrackerEvaluator: Evaluator = {
  name: "USAGE_TRACKER",
  description: "Decrements user's free message count after a successful reply.",
  alwaysRun: true,

  validate: async (runtime: IAgentRuntime, message: Memory) => {
    // Only run for Telegram messages that are not commands.
    const text = message.content.text?.toLowerCase().trim() || "";
    const isCommand = text.startsWith("/") && !text.includes(" ");

    return message.content.source === "telegram" && !isCommand;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory
  ): Promise<ActionResult> => {
    const rateLimiter = runtime.getService<RateLimitService>("rate_limit");

    if (rateLimiter) {
      await rateLimiter.decrement(message.entityId, "telegram");

      return { success: true, text: "User usage decremented." };
    }

    elizaLogger.warn(
      "[UsageTracker] RateLimitService not found, cannot decrement usage."
    );
    return { success: false, error: "RateLimitService not found." };
  },

  examples: [],
};
