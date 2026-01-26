import {
  Action,
  IAgentRuntime,
  Memory,
  State,
  elizaLogger,
  ActionResult,
} from "@elizaos/core";

export const rateLimitAction: Action = {
  name: "INFORM_RATE_LIMIT_EXCEEDED",
  // This action is triggered programmatically by the provider, not by user text.
  similes: [],
  description:
    "INTERNAL ACTION: Informs the user that their free message quota has been exceeded and directs them to the full application.",

  /**
   * This action is always valid because the accessProvider will force its execution when needed.
   */
  validate: async () => true,

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<ActionResult> => {
    elizaLogger.warn(
      `Executing INFORM_RATE_LIMIT_EXCEEDED for user ${message.entityId}.`,
    );

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

      const denialMessage =
        "You've reached your free message limit for today. For unlimited analysis and historical chat context, please launch the SenseAI Mini App.";

      await telegramService.bot.telegram.sendMessage(chatId, denialMessage, {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🚀 Launch SenseAI",
                // This special object tells Telegram to open a Mini App
                web_app: { url: "https://sense-ai-app.web.app" },
              },
            ],
          ],
        },
      });

      return { success: true };
    } catch (error) {
      elizaLogger.error(
        "[RateLimitAction] Failed to send denial message.",
        String(error),
      );

      return { success: false, error: String(error) };
    }
  },

  examples: [], // Not needed, triggered by provider logic.
};
