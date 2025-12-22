const { z } = require("zod");

// --- Global Constants (Aligned with Frontend) ---
const MAX_PROMPT_LENGTH = 5000; // Matches Chat.jsx
const MAX_TITLE_LENGTH = 100; // Matches RenameConversationModal.jsx
const MAX_INSTRUCTIONS_LENGTH = 1000; // Safe buffer for regeneration instructions

// --- Schemas ---

// 1. PromptSubmitted
const PromptSubmittedSchema = z.object({
  promptText: z.string().min(1).max(MAX_PROMPT_LENGTH),
  isNewConversation: z.boolean(),
  // These can be null/undefined for new conversations
  previousMessageId: z.string().nullable().optional(),
  previousMessageCID: z.string().nullable().optional(),
  // Sapphire specific: The session key is sometimes passed inside the payload
  sessionKey: z.string().optional(),
});

// 2. RegenerationRequested
const RegenerationRequestedSchema = z.object({
  instructions: z.string().min(1).max(MAX_INSTRUCTIONS_LENGTH),
  promptMessageCID: z.string().min(1),
  originalAnswerMessageCID: z.string().min(1),
  sessionKey: z.string().optional(),
});

// 3. BranchRequested
const BranchRequestedSchema = z.object({
  originalTitle: z.string().min(1).max(MAX_TITLE_LENGTH),
  sessionKey: z.string().optional(),
});

// 4. MetadataUpdateRequested
const MetadataUpdateRequestedSchema = z.object({
  title: z.string().min(1).max(MAX_TITLE_LENGTH),
  isDeleted: z.boolean(),
  sessionKey: z.string().optional(),
});

/**
 * Validates and parses the decrypted payload.
 * @param {string|object} input - The decrypted payload (JSON string or Object).
 * @param {string} eventName - The name of the event for schema selection.
 * @returns {object} The validated object.
 * @throws {Error} If validation fails.
 */
function validatePayload(input, eventName) {
  try {
    // Optimization: Handle both String (Sapphire) and Object (EVM Decrypted)
    const obj = typeof input === "string" ? JSON.parse(input) : input;

    let schema;
    switch (eventName) {
      case "PromptSubmitted":
        schema = PromptSubmittedSchema;
        break;
      case "RegenerationRequested":
        schema = RegenerationRequestedSchema;
        break;
      case "BranchRequested":
        schema = BranchRequestedSchema;
        break;
      case "MetadataUpdateRequested":
        schema = MetadataUpdateRequestedSchema;
        break;
      default:
        throw new Error(`No schema defined for event: ${eventName}`);
    }

    // .strip() removes unknown keys to prevent pollution
    return schema.strip().parse(obj);
  } catch (error) {
    // We throw a standardized error that handleAndRecord can detect
    throw new Error(`Validation Failed for ${eventName}: ${error.message}`);
  }
}

module.exports = { validatePayload };
