import {
  Action,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
  elizaLogger,
  ActionResult,
} from "@elizaos/core";

/**
 * Handles specific user commands on Telegram to display the SenseAI Mini App button
 * or provide a welcome message. This action is platform-specific.
 */
export const launchAppAction: Action = {
  name: "LAUNCH_SENSEAI_APP",
  similes: [
    "/app",
    "/help",
    "launch app",
    "start senseai",
    "open app",
    "app",
    "help",
  ],
  description:
    "Handles startup commands for Telegram. Launches the SenseAI Mini App or shows help text depending on the user's input.",

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
    elizaLogger.info(`[LaunchApp Action] Validating. Source is: '${source}'`);

    if (source === "telegram") return true;

    elizaLogger.info(
      `[LaunchApp Action] Validation Failed. Source '${source}' is not 'telegram'.`,
    );
    return false;
  },

  /**
   * The main execution logic for the action. It connects to the Telegram service
   * and sends custom messages with inline keyboards or web_app buttons.
   */
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options: any = {},
    _callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    elizaLogger.info("Executing LAUNCH_SENSEAI_APP action.");

    // Access the internal Telegraf instance via the Telegram service.
    const telegramService = runtime.getService<any>("telegram");

    if (!telegramService || !telegramService.bot) {
      elizaLogger.error(
        "[LaunchApp Action] Telegram service is not available.",
      );

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

      const text = message.content.text?.toLowerCase().trim() || "";
      console.log("text", text);

      // Scenario A: Help message.
      if (text.includes("/help") || text.includes("help")) {
        const responseText = `**SenseAI**
Status: Online 🟢
Environment: Oasis TEE (Secure)

I am ready to analyse market sentiment, on-chain data, and fundamental events.

**Commands:**
/menu - Quick Actions & Tools
/app - Launch SenseAI dApp (Full Service)

*Upload an image to trigger visual chart analysis.*`;

        await telegramService.bot.telegram.sendMessage(chatId, responseText, {
          parse_mode: "Markdown",
        });
      }

      // Scenario B: Launch App button. This is intentionally not an 'else if' to allow
      if (
        text.includes("/app") ||
        text.includes("launch") ||
        text.includes("open")
      ) {
        await telegramService.bot.telegram.sendMessage(
          chatId,
          "Click the button below to launch the SenseAI dApp:",
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "🚀 Launch SenseAI",
                    // This special object tells Telegram to open a Mini App
                    web_app: { url: "https://sense-ai-app.web.app" },
                  },
                ],
                [
                  {
                    text: "Visit Tradable.app",
                    url: "https://tradable.app",
                  },
                ],
              ],
            },
          },
        );
      }

      return { success: true };
    } catch (error) {
      elizaLogger.error(
        "[LaunchApp Action] Failed to send Telegram message.",
        String(error),
      );

      return { success: false, error: String(error) };
    }
  },

  // Examples for the LLM to learn when to trigger this action.
  examples: [
    [
      { name: "{{name1}}", content: { text: "/app" } },
      {
        name: "SenseAI",
        content: {
          text: "Launching the SenseAI Mini App interface now.",
          action: "LAUNCH_SENSEAI_APP",
        },
      },
    ],
    [
      { name: "{{name1}}", content: { text: "how do I start?" } },
      {
        name: "SenseAI",
        content: {
          text: "Welcome. Launching the main interface.",
          action: "LAUNCH_SENSEAI_APP",
        },
      },
    ],
    [
      { name: "{{name1}}", content: { text: "can you help me" } },
      {
        name: "SenseAI",
        content: {
          text: "Of course, here is the welcome message.",
          action: "LAUNCH_SENSEAI_APP",
        },
      },
    ],
  ],
};
