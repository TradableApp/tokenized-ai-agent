import {
  Provider,
  IAgentRuntime,
  Memory,
  State,
  ProviderResult,
  elizaLogger,
  ContentType,
} from "@elizaos/core";

/**
 * Detects image attachments in user messages and injects a system directive
 * to force the use of the ANALYZE_CHART action.
 */
export const imageDetectionProvider: Provider = {
  name: "IMAGE_DETECTION_OVERRIDE",
  position: -90, // Run early, right after access control

  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State
  ): Promise<ProviderResult> => {
    elizaLogger.info(
      `[ImageDetectionProvider] Checking for image attachments. Has image: ${JSON.stringify(message)}`
    );

    const hasImage = message.content.attachments?.some((att) => {
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
      `[ImageDetectionProvider] Checking for image attachments. Has image: ${hasImage}`
    );

    if (hasImage) {
      elizaLogger.info(
        "[ImageDetectionProvider] Image detected! Injecting SYSTEM OVERRIDE for chart analysis."
      );

      return {
        text: `
        ### URGENT SYSTEM DIRECTIVE: IMAGE DETECTED
        The user has uploaded an image.
        
        You are FORBIDDEN from using the REPLY action to say you cannot see.
        You MUST execute the "ANALYZE_CHART" action to process the visual input.
        `,
        values: {},
        data: {},
      };
    }

    // If no image, inject nothing.
    return { text: "", values: {}, data: {} };
  },
};
