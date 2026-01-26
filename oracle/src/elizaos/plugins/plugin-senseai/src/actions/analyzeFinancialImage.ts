import {
  Action,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
  elizaLogger,
  ActionResult,
  ModelType,
  ContentType,
} from "@elizaos/core";
import axios from "axios";

/**
 * Performs analysis on user-provided images (Charts, Tables, Screenshots) using a multimodal vision model.
 */
export const analyzeFinancialImageAction: Action = {
  name: "ANALYZE_FINANCIAL_IMAGE",
  similes: [
    "analyze this image",
    "what do you see",
    "read this screenshot",
    "analyze chart",
    "scan image",
    "extract data from image",
  ],
  description:
    "Analyzes images for financial data. Handles Charts (TA), Tables (Price/Volume), News (Sentiment), or Portfolio screenshots. Rejects non-financial images.",

  /**
   * Validates that the message contains at least one attachment with the 'image' contentType.
   */
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    if (
      !message.content.attachments ||
      message.content.attachments.length === 0
    ) {
      return false;
    }

    // This is the robust check.
    const hasImage = message.content.attachments.some((att) => {
      // Primary check: The official contentType enum
      if (att.contentType === ContentType.IMAGE) return true;

      // Fallback check: For Telegram "document" images, parse the description.
      // This is a safe workaround for the plugin's behavior.
      if (att.description?.includes("Type: image/")) return true;

      // Another Fallback: Sometimes the contentType is a raw string
      if (
        typeof att.contentType === "string" &&
        att.contentType.startsWith("image/")
      )
        return true;

      return false;
    });
    elizaLogger.info(
      `[AnalyzeImage Action] Validation check for image: ${hasImage}`,
    );

    return !!hasImage;
  },

  /**
   * The main handler. It extracts the image URL and user's text, then calls the configured vision model
   * to generate a technical analysis of the chart.
   */
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options: any = {},
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    elizaLogger.info("Executing ANALYZE_FINANCIAL_IMAGE action.");

    const imageAttachment = message.content.attachments?.find((att) => {
      // Primary check: The official contentType enum
      if (att.contentType === ContentType.IMAGE) return true;

      // Fallback check: For Telegram "document" images, parse the description.
      // This is a safe workaround for the plugin's behavior.
      if (att.description?.includes("Type: image/")) return true;

      // Another Fallback: Sometimes the contentType is a raw string
      if (
        typeof att.contentType === "string" &&
        att.contentType.startsWith("image/")
      )
        return true;

      return false;
    });

    if (!imageAttachment?.url) {
      return { success: false, error: "No image URL found." };
    }

    const userText =
      message.content.text ||
      "Analyse this image and provide a technical summary.";

    const systemPrompt = `You are SenseAI, a sovereign market analyst. You are objective, data-driven, and use Australian English.

    TASK: Analyse the provided image. Determine the category and provide the appropriate analysis:
    
    1. **TECHNICAL CHART:** Identify price action, support/resistance, indicators (RSI/MACD), and trend structure.
    2. **DATA TABLE / SCREENSHOT:** (e.g. CoinGecko, Portfolio): Extract key metrics, outliers, and summarize the financial state.
    3. **TEXT / NEWS:** Extract the headline and assess the market sentiment impact.
    4. **UNRELATED / NOISE:** If the image is not related to crypto, finance, or markets (e.g. a pet, a landscape, a meme without context), reply EXACTLY: "I cannot extract financial signal from this image. Please provide market-relevant data."

    CONSTRAINTS:
    - Do NOT provide financial advice.
    - Focus on data, structure, and verifiable metrics.

    ASSOCIATED USER PROMPT: ${userText}
    `;

    try {
      elizaLogger.info(`[AnalyzeImage] Fetching: ${imageAttachment.url}`);
      const imageResponse = await axios.get(imageAttachment.url, {
        responseType: "arraybuffer",
      });
      const imageBuffer = Buffer.from(imageResponse.data, "binary");
      const base64Image = imageBuffer.toString("base64");

      // Determine the correct MIME type, defaulting to png
      const mimeType = imageAttachment.description?.includes("image/jpeg")
        ? "image/jpeg"
        : "image/png";

      elizaLogger.info(
        `[AnalyzeImage] Image fetched. Size: ${imageBuffer.length} bytes, MIME Type: ${mimeType}`,
      );

      // The google-genai plugin handles this multimodal format when sent to a text model type.
      const analysisResult = await runtime.useModel(
        ModelType.IMAGE_DESCRIPTION,
        {
          /** The URL or path of the image to describe */
          imageUrl: `data:${mimeType};base64,${base64Image}`,
          /** Optional prompt to guide the description */
          prompt: systemPrompt,
        },
      );
      elizaLogger.info(
        `Received analysis result from vision model: ${analysisResult}`,
      );

      const analysisText =
        typeof analysisResult === "string"
          ? analysisResult
          : "I was unable to provide a detailed analysis of the image at this time.";

      if (callback) {
        await callback({
          text: analysisText,
          source: "telegram",
        });
      }

      return { success: true };
    } catch (error) {
      elizaLogger.error("Vision analysis failed", String(error));

      const errorMessage = "I encountered an error processing the visual data.";
      if (callback) {
        await callback({ text: errorMessage, source: "telegram" });
      }

      return { success: false, error: errorMessage };
    }
  },

  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "analyse this chart for me",
          attachments: [
            {
              id: "mock-image-id-123",
              url: "https://example.com/mock-chart.png",
              contentType: ContentType.IMAGE,
            },
          ],
        },
      },
      {
        name: "SenseAI",
        content: {
          text: "Analysing the chart...",
          action: "ANALYZE_FINANCIAL_IMAGE",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "what do you think of this setup?",
          attachments: [
            {
              id: "mock-image-id-456",
              url: "https://example.com/mock-chart.png",
              contentType: ContentType.IMAGE,
            },
          ],
        },
      },
      {
        name: "SenseAI",
        content: {
          text: "Analysing the setup...",
          action: "ANALYZE_FINANCIAL_IMAGE",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "what does this portfolio look like?",
          attachments: [
            { id: "1", url: "img.png", contentType: ContentType.IMAGE },
          ],
        },
      },
      {
        name: "SenseAI",
        content: {
          text: "Scanning asset allocation...",
          action: "ANALYZE_FINANCIAL_IMAGE",
        },
      },
    ],
  ],
};
