// A conversation's key file: the session key, encrypted for the oracle, stored once per
// conversation as hex text. Its tags and its name are decided here, for every writer and reader.
//
// On Autonomys the file is found by its name in the account's own files (`autonomys.js`), so the
// name is fixed by chain and conversation. The `.txt` ending keeps one conversation's name from
// being the start of another's (`rofl-key-8453-7.txt` is not part of `rofl-key-8453-70.txt`).

const KEY_FILE_CONTENT_TYPE = "application/rofl-key";
const KEY_FOR_CONVERSATION_TAG = "SenseAI-Key-For-Conversation";
const FILE_NAME_TAG = "File-Name";

/** The key file's name for a `<chainId>-<conversationId>` value. */
function keyFileName(keyForConversation) {
  return `rofl-key-${keyForConversation}.txt`;
}

/** The tags a key file is looked up by (as written by every version of the oracle). */
function keyFileLookupTags(chainId, conversationId) {
  return [
    { name: "Content-Type", value: KEY_FILE_CONTENT_TYPE },
    { name: KEY_FOR_CONVERSATION_TAG, value: `${chainId}-${conversationId}` },
  ];
}

/** The tags a key file is uploaded with: the lookup tags and its fixed name. */
function keyFileUploadTags(chainId, conversationId) {
  return [
    ...keyFileLookupTags(chainId, conversationId),
    { name: FILE_NAME_TAG, value: keyFileName(`${chainId}-${conversationId}`) },
  ];
}

module.exports = {
  KEY_FOR_CONVERSATION_TAG,
  keyFileName,
  keyFileLookupTags,
  keyFileUploadTags,
};
