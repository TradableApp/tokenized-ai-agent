import {
  Plugin,
  elizaLogger,
  IAgentRuntime,
  Memory,
  stringToUuid,
  ContentType,
  ChannelType,
} from "@elizaos/core";
import { analyzeFinancialImageAction } from "./actions/analyzeFinancialImage";
import { handleMenuCallbackAction } from "./actions/handleMenuCallback";
import { launchAppAction } from "./actions/launchApp";
import { rateLimitAction } from "./actions/rateLimitAction";
import { showMenuAction } from "./actions/showMenu";
import { accessProvider } from "./providers/accessProvider";
import { imageDetectionProvider } from "./providers/imageDetectionProvider";
import { usageTrackerEvaluator } from "./evaluators/usageTracker";
import { RateLimitService } from "./services/rateLimit";

const senseaiPlugin: Plugin = {
  name: "senseai",
  priority: 100,
  description: "SenseAI Logic: Rate Limiting, App Launching, and Sovereignty",

  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    // We need to wait a moment for the Telegram Service to be ready
    setTimeout(async () => {
      try {
        const telegramService = runtime.getService<any>("telegram");
        if (telegramService && telegramService.bot) {
          const bot = telegramService.bot;
          elizaLogger.info("[SenseAI] Configuring Telegram UX elements...");

          // 1. Set the "Pre-Start" Description (What they see before clicking Start)
          // This solves the "Welcome Message" problem natively
          await bot.telegram.setMyDescription(
            `Agent: SenseAI
Environment: Oasis TEE (Secure)

I provide institutional-grade crypto sentiment/fundamental analysis based on verifiable data.

TRY ASKING ME:
"What is the sentiment on ETH?"
"Analyse this chart" (Upload an image)
"Show me the top gainers today"
"Is SOL overvalued based on TVL?"

Tap 'Start' to initialise the secure session.`,
          );

          // 2. Set the "About" Text (Profile Info)
          await bot.telegram.setMyShortDescription(
            "Official SenseAI dApp. Powered by Tradable, Aurora & Oasis ROFL.",
          );

          // 3. Set the Commands (Removing /start as requested)
          await bot.telegram.setMyCommands([
            { command: "menu", description: "Open Quick Actions" },
            { command: "app", description: "Launch SenseAI" },
            { command: "help", description: "Get Assistance" },
          ]);

          // 4. Force the Menu Button (The Blue Button)
          // We use a try/catch specifically for this as it can be finicky
          try {
            await bot.telegram.setChatMenuButton({
              menu_button: {
                type: "web_app",
                text: "Launch SenseAI",
                web_app: { url: "https://sense-ai-app.web.app" },
              },
            });
            elizaLogger.info("[SenseAI] Menu Button set to Web App mode.");
          } catch (btnError) {
            elizaLogger.error(
              "[SenseAI] Failed to set Menu Button:",
              String(btnError),
            );
          }

          elizaLogger.info("[SenseAI] Telegram UX configuration complete.");
        }
      } catch (error) {
        elizaLogger.error(
          "[SenseAI] Failed to configure Telegram UX:",
          String(error),
        );
      }
    }, 5000); // 5s delay
  },

  actions: [
    analyzeFinancialImageAction,
    handleMenuCallbackAction,
    launchAppAction,
    rateLimitAction,
    showMenuAction,
  ],
  providers: [accessProvider, imageDetectionProvider],
  services: [RateLimitService],
  evaluators: [usageTrackerEvaluator],
};

export { RateLimitService };
export default senseaiPlugin;
