"use strict";

// The oracle's remover of addresses: whole addresses, configured secrets and network peers.
const { withoutAddresses } = require("../../oracle/src/errorDescription");
const { refreshRequestSecrets } = require("../../oracle/src/requestSecrets");

/**
 * What a script prints when a run fails.
 *
 * A refusal the script wrote itself (an instance of `Refusal`) is printed whole. Any other error
 * is printed as its message with every address removed, followed by the frames that say where
 * it was thrown. The error's own stack is never printed: ethers puts the request's address in a
 * provider error's message, a stack starts with the message, and that address usually holds the
 * account's access key. Frames hold file paths and positions only. The rest of the message is
 * kept as written, since a script's plain errors are instructions to the person running it.
 *
 * @param {unknown} error
 * @param {Function} [Refusal] the script's own error class, if it has one
 * @returns {string}
 */
function failureText(error, Refusal) {
  if (Refusal && error instanceof Refusal) return error.message;
  // The configured secrets are read again here: this module can be loaded before the settings
  // file is, and a key written without its address ("POST /v2/<key>") is removed by value.
  refreshRequestSecrets();
  const message = withoutAddresses(String(error?.message ?? error));
  const frames =
    typeof error?.stack === "string"
      ? error.stack.split("\n").filter((line) => /^\s+at /.test(line))
      : [];
  return [message, ...frames].join("\n");
}

module.exports = { failureText };
