import {
  Action,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
  elizaLogger,
  ActionResult,
} from "@elizaos/core";

export const getSentimentAction: Action = {
  name: "GET_MARKET_SENTIMENT",
  similes: ["CHECK_SENTIMENT", "MARKET_MOOD", "SENTIMENT_ANALYSIS"],
  description: "Fetches social sentiment and on-chain metrics from Santiment.",

  validate: async () => true,

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options: any = {},
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    elizaLogger.info("Executing GET_MARKET_SENTIMENT action");

    // TODO: Integrate actual Santiment API call here
    // For now, returning mock data to prove the flow
    const sentimentData = {
      btc: "Neutral/Bullish",
      socialVolume: "High",
      devActivity: "Increasing",
    };

    const text = `**Market Sentiment Analysis**
        
BTC Sentiment: ${sentimentData.btc}
Social Volume: ${sentimentData.socialVolume}
Dev Activity: ${sentimentData.devActivity}

*Data provided by Santiment (Simulated)*`;

    // We use the passed-in callback.
    // This abstracts away the "how" of sending the message (Telegram vs Discord vs Web).
    if (callback) {
      await callback({
        text: text,
        source: message.content.source,
        // Metadata is optional; other platforms will ignore telegram-specific fields
        metadata: { telegram: { parse_mode: "Markdown" } },
      });
    }

    return { success: true, text };
  },

  examples: [
    [
      { name: "{{name1}}", content: { text: "check market sentiment" } },
      {
        name: "SenseAI",
        content: {
          text: "Here is the current market sentiment...",
          action: "GET_MARKET_SENTIMENT",
        },
      },
    ],
  ],
};
