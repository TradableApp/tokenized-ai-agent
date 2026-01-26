import {
  Action,
  IAgentRuntime,
  Memory,
  ActionResult,
  elizaLogger,
  HandlerCallback,
  State,
} from "@elizaos/core";

/**
 * Displays an interactive menu of common SenseAI commands as an inline keyboard in Telegram.
 * This action is platform-specific and provides a better user experience than text commands.
 */
export const showMenuAction: Action = {
  name: "SHOW_QUICK_ACTIONS_MENU",
  similes: ["menu", "options", "quick actions", "/menu"],
  description:
    "Displays an interactive menu of common SenseAI commands in Telegram.",

  /**
   * Validates that the action only runs for messages originating from Telegram.
   * This acts as a guardrail, preventing this UI-specific action from firing in other contexts (e.g., the web dApp).
   */
  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ) => {
    const source = message.content.source;
    elizaLogger.info(`[ShowMenu Action] Validating. Source is: '${source}'`);

    if (source === "telegram") return true;

    elizaLogger.info(
      `[ShowMenu Action] Validation Failed. Source '${source}' is not 'telegram'.`,
    );
    return false;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options: any = {},
    _callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    elizaLogger.info("Executing SHOW_QUICK_ACTIONS_MENU action.");

    // Access the internal Telegraf instance via the Telegram service.
    const telegramService = runtime.getService<any>("telegram");

    if (!telegramService || !telegramService.bot) {
      elizaLogger.error("[ShowMenu Action] Telegram service is not available.");

      return { success: false, error: "Telegram service missing." };
    }

    try {
      // The raw Telegram Chat ID is stored in the room's 'channelId' property by the plugin.
      const room = await runtime.getRoom(message.roomId);
      const chatId = room?.channelId;

      if (!chatId) {
        return {
          success: false,
          error: `Could not find a valid Telegram Chat ID for room ${message.roomId}.`,
        };
      }

      await telegramService.bot.telegram.sendMessage(
        chatId,
        "**SenseAI Terminal**\nSelect a data stream or action:",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              // Row 1: High Value Data
              [
                {
                  text: "📉 Market Overview",
                  callback_data: "action:market_overview",
                },
                {
                  text: "📊 Sentiment Scan",
                  callback_data: "action:market_sentiment",
                },
              ],
              // Row 2: Utility
              [
                {
                  text: "💡 Prompt Cheat Sheet",
                  callback_data: "action:show_examples",
                },
                {
                  text: "💰 Get BTC Price",
                  callback_data: "action:get_btc_price",
                },
              ],
              // Row 3: App Upsell (Prominent)
              [
                {
                  text: "🚀 Launch SenseAI",
                  web_app: { url: "https://sense-ai-app.web.app" },
                },
              ],
            ],
          },
        },
      );

      return { success: true };
    } catch (error) {
      elizaLogger.error(
        "[ShowMenu Action] Failed to send quick actions menu.",
        String(error),
      );

      return { success: false, error: String(error) };
    }
  },

  examples: [
    [
      { name: "{{name1}}", content: { text: "/menu" } },
      {
        name: "SenseAI",
        content: {
          text: "**SenseAI Terminal**\nSelect a data stream or action:",
          action: "SHOW_QUICK_ACTIONS_MENU",
        },
      },
    ],
    [
      { name: "{{name1}}", content: { text: "show me my options" } },
      {
        name: "SenseAI",
        content: {
          text: "**SenseAI Terminal**\nSelect a data stream or action:",
          action: "SHOW_QUICK_ACTIONS_MENU",
        },
      },
    ],
  ],
};
