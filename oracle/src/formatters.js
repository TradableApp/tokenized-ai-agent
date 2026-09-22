const { removeStopwords, eng } = require("stopword");

/**
 * Creates a ConversationFile object. This file represents the immutable core
 * of a conversation and is typically created only once.
 * @param {{
 *   id: string,
 *   ownerAddress: string,
 *   createdAt: number,
 *   roflEncryptedKey: string,
 *   branchedFromConversationId?: string,
 *   branchedAtMessageId?: string
 * }} params
 * @returns {object} A valid ConversationFile object.
 */
function createConversationFile({
  id,
  ownerAddress,
  createdAt,
  roflEncryptedKey,
  branchedFromConversationId,
  branchedAtMessageId,
}) {
  const conversationFile = {
    id,
    ownerAddress,
    createdAt,
    roflEncryptedKey, // Stored for future oracle access
  };
  if (branchedFromConversationId) {
    conversationFile.branchedFromConversationId = branchedFromConversationId;
  }
  if (branchedAtMessageId) {
    conversationFile.branchedAtMessageId = branchedAtMessageId;
  }
  return conversationFile;
}

/**
 * Creates a ConversationMetadataFile object. This file contains the mutable
 * metadata of a conversation, like its title. A new version is created for each update.
 * @param {{
 *   title: string,
 *   isDeleted: boolean,
 *   lastUpdatedAt: number
 * }} params
 * @returns {object} A valid ConversationMetadataFile object.
 */
function createConversationMetadataFile({ title, isDeleted, lastUpdatedAt }) {
  return {
    title,
    isDeleted,
    lastUpdatedAt,
  };
}

/**
 * Creates a MessageFile object for either a user or an assistant.
 * @param {{
 *   id: string,
 *   conversationId: string,
 *   parentId: string | null,
 *   parentCID: string | null,
 *   createdAt: number,
 *   role: 'user' | 'assistant',
 *   content: string | null,
 *   sources?: Array<{title: string, url: string}>,
 *   reasoning?: Array<{title: string, description: string}>,
 *   reasoningDuration?: number
 * }} params
 * @returns {object} A valid MessageFile object.
 */
function createMessageFile({
  id,
  conversationId,
  parentId,
  parentCID,
  createdAt,
  role,
  content,
  sources = [],
  reasoning = [],
  reasoningDuration,
}) {
  const messageFile = {
    id,
    conversationId,
    parentId,
    parentCID,
    createdAt,
    role,
    content,
  };
  // User messages do not have these AI-specific fields.
  if (role === "assistant") {
    messageFile.sources = sources;
    messageFile.reasoning = reasoning;
    if (reasoningDuration !== undefined) {
      messageFile.reasoningDuration = reasoningDuration;
    }
  }
  return messageFile;
}

/**
 * Generates a string of keywords from a given text content, consistent
 * with the frontend search service.
 * @param {string} content The text to process.
 * @returns {string} A space-separated string of keywords.
 */
function generateKeywords(content = "") {
  if (!content) return "";
  const tokens = content
    .toLowerCase()
    .replace(/\n/g, " ")
    .replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, " ")
    .replace(/\s{2,}/g, " ")
    .split(" ");
  // Trim the final result to remove leading/trailing spaces
  return removeStopwords(tokens, eng).join(" ").trim();
}

/**
 * Creates a SearchIndexDeltaFile object. This file contains keywords from a single
 * user message to be added to the client-side search index.
 * @param {{
 *   conversationId: string,
 *   messageId: string,
 *   userMessageContent: string
 * }} params
 * @returns {object} A valid SearchIndexDeltaFile object, e.g., { "msg_123": { cid: "conv_456", c: "keywords..." } }.
 */
function createSearchIndexDeltaFile({ conversationId, messageId, userMessageContent }) {
  const keywords = generateKeywords(userMessageContent);
  // The key is the messageId. The value is an object.
  return {
    [messageId]: {
      cid: conversationId,
      c: keywords,
    },
  };
}

/**
 * `JSON.stringify` replacer that renders BigInt as its decimal string.
 *
 * Ethers v6 returns BigInt for every uint256, so anything holding a raw `event.args` — the
 * failed-jobs queue above all — cannot be stringified without one: `JSON.stringify` THROWS on a
 * BigInt rather than skipping it. That throw landed inside the error handler that was trying to
 * queue a retryable job, so the job was never queued and the block cursor never advanced. A
 * recoverable failure became a silent loss.
 *
 * Decimal STRING, never Number. Conversation and message ids routinely exceed
 * Number.MAX_SAFE_INTEGER, so `Number(bigint)` would round them into a different id — the kind
 * of corruption that reads as a mystery rather than an error.
 */
function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

module.exports = {
  createConversationFile,
  createConversationMetadataFile,
  createMessageFile,
  createSearchIndexDeltaFile,
  jsonReplacer,
  // also export for testing or direct use if needed
  generateKeywords,
};
