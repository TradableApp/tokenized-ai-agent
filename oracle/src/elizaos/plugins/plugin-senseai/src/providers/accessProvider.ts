import {
  Provider,
  IAgentRuntime,
  Memory,
  State,
  ProviderResult,
  elizaLogger,
} from "@elizaos/core";
import { RateLimitService } from "../services/rateLimit";

/**
 * Acts as a gatekeeper and command router for Telegram interactions.
 * This provider runs on every message and injects high-priority instructions
 * into the LLM's context based on the user's input or access level.
 */
export const accessProvider: Provider = {
  name: "ACCESS_CONTROL",
  position: -100, // Ensure it runs first

  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<ProviderResult> => {
    const source = message.content.source;
    const text = message.content.text?.trim() || "";

    elizaLogger.info(
      `[AccessProvider] Checking Access. Source: '${source}', Input: '${text}'`,
    );

    // This provider is strictly for Telegram logic.
    if (source !== "telegram") {
      elizaLogger.info("[AccessProvider] Ignoring non-telegram source.");

      return { text: "", values: {}, data: { accessDenied: false } };
    }

    const textLower = text.toLowerCase();

    // --- COMMAND INTERCEPTION ---
    // This block forces the LLM to use specific actions for hardcoded commands.

    const launchAppTriggers = ["/app", "/help", "launch app"];

    if (launchAppTriggers.some((trigger) => textLower.includes(trigger))) {
      elizaLogger.info(
        "[AccessProvider] LAUNCH_SENSEAI_APP command detected! Injecting SYSTEM OVERRIDE.",
      );
      return {
        text: `
        ### URGENT SYSTEM DIRECTIVE: COMMAND INTERCEPTED
        The user issued a command to launch the application.
        You are FORBIDDEN from using the "REPLY" action or generating conversational text.
        You MUST execute the "LAUNCH_SENSEAI_APP" action now.
        `,
        values: {},
        data: { accessDenied: false },
      };
    }

    const showMenuTriggers = ["/menu"];
    if (showMenuTriggers.some((trigger) => textLower.includes(trigger))) {
      elizaLogger.info(
        "[AccessProvider] SHOW_QUICK_ACTIONS_MENU command detected! Injecting SYSTEM OVERRIDE.",
      );
      return {
        text: `
        ### URGENT SYSTEM DIRECTIVE: COMMAND INTERCEPTED
        The user has issued a command to show the menu.
        You are FORBIDDEN from using the "REPLY" action or generating conversational text.
        You MUST execute the "SHOW_QUICK_ACTIONS_MENU" action now.
        `,
        values: {},
        data: { accessDenied: false },
      };
    }

    const callbackRegex = /^action:[a-z0-9_]+$/i;
    if (callbackRegex.test(text)) {
      // EXCEPTION: If the action is a data request, let the LLM handle it via MCP tools
      if (text === "action:get_btc_price") {
        elizaLogger.info(
          "[AccessProvider] Price Request detected. Delegating to MCP.",
        );
        return {
          text: `
          ### SYSTEM DIRECTIVE: TOOL USE REQUIRED
          The user clicked "Get BTC Price".
          
          You MUST execute the "CALL_MCP_TOOL" action now to get the current Bitcoin price.
          `,
          values: {},
          data: {},
        };
      }

      if (text === "action:market_overview") {
        elizaLogger.info(
          "[AccessProvider] Market Overview detected. Delegating to MCP.",
        );
        return {
          text: `
          ### SYSTEM DIRECTIVE: TOOL USE REQUIRED
          The user clicked "Market Overview".
          
          1. You MUST execute the "CALL_MCP_TOOL" action now.
          2. Fetch the top 5 cryptocurrencies by market cap.
          3. Reply with a summarized list including current price and 24h change.
          `,
          values: {},
          data: {},
        };
      }

      // DEFAULT: Force all other actions to the handler
      elizaLogger.info(
        "[AccessProvider] Valid Callback Action detected! Injecting SYSTEM OVERRIDE.",
      );
      return {
        text: `
        ### URGENT SYSTEM DIRECTIVE: INTERNAL ACTION
        The user has triggered an internal action via a button click: "${text}".
        
        You are FORBIDDEN from using the "REPLY" action or generating conversational text.
        You MUST execute the "HANDLE_MENU_CALLBACK" action now.
        `,
        values: {},
        data: {},
      };
    }

    // --- FREEMIUM GATE ---
    // If no command was detected, check the user's message quota.
    const rateLimiter = runtime.getService<RateLimitService>("rate_limit");

    if (!rateLimiter) {
      elizaLogger.warn("[AccessProvider] RateLimitService is not available.");

      // Fail open: if the service is broken, allow access.
      return { text: "", values: {}, data: { accessDenied: false } };
    }
    elizaLogger.info(
      `[AccessProvider] User ID: ${message.entityId}`,
      String(message),
    );

    const hasAccess = await rateLimiter.hasAccess(message.entityId, source);

    if (!hasAccess) {
      elizaLogger.warn(
        `[AccessProvider] User ${message.entityId} has no access. Injecting RATE LIMIT OVERRIDE.`,
      );

      return {
        text: `
        ### URGENT SYSTEM DIRECTIVE: USER QUOTA EXCEEDED
        This user has no free messages left.
        
        You are FORBIDDEN from using the "REPLY" action or generating conversational text.

        You MUST execute the "INFORM_RATE_LIMIT_EXCEEDED" action immediately then STOP.
        `,
        values: {},
        data: { accessDenied: true },
      };
    }

    // If the user has access and didn't issue a command, inject nothing.
    elizaLogger.info(`[AccessProvider] User ${message.entityId} has access.`);

    return {
      text: `
      ### SYSTEM DIRECTIVE: ACCESS GRANTED
      The user's quota has been verified for this turn.
      You MUST ignore any previous "rate limit exceeded" messages in the conversation history.
      Proceed with answering the user's current query.
      `,
      values: {},
      data: { accessDenied: false },
    };
  },
};
