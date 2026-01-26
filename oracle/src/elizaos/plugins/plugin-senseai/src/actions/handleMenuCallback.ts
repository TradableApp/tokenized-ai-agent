import {
  Action,
  IAgentRuntime,
  Memory,
  ActionResult,
  elizaLogger,
  State,
  HandlerCallback,
} from "@elizaos/core";
import { getSentimentAction } from "./getSentimentAction";

/**
 * Handles callback queries generated from inline keyboard buttons in Telegram.
 * This action acts as a router to perform tasks requested via the interactive menu.
 */
export const handleMenuCallbackAction: Action = {
  name: "HANDLE_MENU_CALLBACK",
  // This action is triggered internally, not by user text, so similes are less critical.
  similes: ["action:", "handle_callback"],
  description: "Processes callbacks from Telegram inline keyboards.",

  validate: async (runtime: IAgentRuntime, message: Memory) => {
    // This action is only valid if the message text starts with our 'action:' prefix.
    return message.content.text?.startsWith("action:") ?? false;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options: any = {},
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const callbackData = message.content.text || "";
    elizaLogger.info(
      `[HandleMenuCallback] Processing callback: ${callbackData}`,
    );

    // Parse the action from the callback data (e.g., "action:market_sentiment")
    const requestedAction = callbackData.split(":")[1];
    elizaLogger.info(`[HandleMenuCallback] Routing action: ${requestedAction}`);

    try {
      // --- ROUTER ---

      switch (requestedAction) {
        case "market_sentiment": {
          // OPTION A: Direct Import (Best for actions we own)
          // We pass the 'callback' through.
          // getSentimentAction will call it, sending a NEW message to the user.
          const result = await getSentimentAction.handler(
            runtime,
            message,
            state,
            options,
            callback,
          );

          return (result as ActionResult) || { success: true };
        }

        case "show_examples": {
          const cheatSheet = `**SenseAI Prompt Cheat Sheet**
      
**Market Data:**
• "Price of [Asset]"
• "Top gainers 24h"
• "Market Cap of SOL"

**Visual Analysis:**
• Upload any chart image -> "Analyse this"
• Upload a portfolio screenshot -> "Rate this portfolio"

**Deep Dives:**
• "Compare ETH vs SOL valuation"
• "What are the risks of [Token]?"

*Tip: I am most effective when you ask for specific data points.*`;

          if (callback) {
            await callback({
              text: cheatSheet,
              source: "telegram",
              metadata: { telegram: { parse_mode: "Markdown" } },
            });
          }
          return { success: true, text: "Cheat sheet sent" };
        }

        // These cases are primarily handled by AccessProvider delegating to MCP,
        // but we include them here as a fallback safe return in case execution falls through.
        case "get_btc_price":
        case "market_overview": {
          elizaLogger.info(
            `[HandleMenuCallback] Action '${requestedAction}' delegated to MCP pipeline.`,
          );
          return { success: true };
        }

        default: {
          elizaLogger.warn(
            `[HandleMenuCallback] Unknown action requested: ${requestedAction}`,
          );
          return { success: false, error: "Unknown action requested" };
        }
      }
    } catch (error) {
      elizaLogger.error(
        `[HandleMenuCallback] Error processing action '${requestedAction}'`,
        String(error),
      );

      if (callback) {
        await callback({
          text: "Sorry, I encountered an error processing that request.",
          source: message.content.source,
        });
      }

      return { success: false, error: String(error) };
    }
  },

  examples: [], // Not needed as this isn't triggered by user text.
};
