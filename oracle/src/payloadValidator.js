const { z } = require("zod");
const { BadInputError } = require("./errors");
const { errorKind } = require("./errorDescription");
const { isContentId } = require("./storage/contentId");

// --- Global Constants (Aligned with Frontend) ---
const MAX_PROMPT_LENGTH = 5000; // Matches Chat.jsx
const MAX_TITLE_LENGTH = 100; // Matches RenameConversationModal.jsx
const MAX_INSTRUCTIONS_LENGTH = 1000; // Safe buffer for regeneration instructions

// A content id the oracle will fetch, or store as a parent for a later fetch: only the shapes
// its storage paths produce (storage/contentId.js), read when the payload is checked, so the
// mock and local IPFS forms are taken only where those modes are on. A refusal is the issue's
// code ("custom"), never the value.
const ContentId = z.string().refine((value) => isContentId(value), { message: "not a content id" });

// --- Schemas ---

// 1. PromptSubmitted
const PromptSubmittedSchema = z.object({
  promptText: z.string().min(1).max(MAX_PROMPT_LENGTH),
  isNewConversation: z.boolean(),
  // These can be null/undefined for new conversations
  previousMessageId: z.string().nullable().optional(),
  previousMessageCID: ContentId.nullable().optional(),
  // Sapphire specific: The session key is sometimes passed inside the payload
  sessionKey: z.string().optional(),
});

// 2. RegenerationRequested
const RegenerationRequestedSchema = z.object({
  instructions: z.string().min(1).max(MAX_INSTRUCTIONS_LENGTH),
  promptMessageCID: ContentId,
  originalAnswerMessageCID: ContentId,
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
    // TYPED so handleAndRecord can detect it without matching on message text. A schema mismatch
    // is the one case where dropping the event permanently is correct.
    // The kind only: a schema or parse error's message describes, and can quote, the user's
    // decrypted payload.
    // Which field failed and how is the schema's text, and is kept: never what was received or
    // the issue's own message.
    const issues = issuesOf(error);
    throw new BadInputError(
      `Validation Failed for ${eventName} (${errorKind(error)}${issues ? `: ${issues}` : ""}).`,
      { cause: error },
    );
  }
}

// The most issues named; a payload that fails everywhere is described by its first few.
const MAX_ISSUES = 5;
const FIELD = /^[A-Za-z_$][\w$]{0,63}$/;
const ISSUE_CODE = /^[a-z_]{1,32}$/;

/** Each failing field and the kind of its failure ("promptText too_small"), or "". */
function issuesOf(error) {
  const issues = Array.isArray(error?.issues) ? error.issues : [];
  return issues
    .slice(0, MAX_ISSUES)
    .map((issue) => {
      const path = Array.isArray(issue?.path) ? issue.path : [];
      const field =
        path
          .map((part) => (Number.isInteger(part) || FIELD.test(String(part)) ? String(part) : "…"))
          .join(".") || "(payload)";
      const code =
        typeof issue?.code === "string" && ISSUE_CODE.test(issue.code) ? issue.code : "invalid";
      return `${field} ${code}`;
    })
    .join(", ");
}

module.exports = { validatePayload };
