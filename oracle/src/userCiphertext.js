"use strict";

/**
 * Reading what a prompt's sender controls: the session key wrapped to the oracle's public key,
 * and the payload bytes. Both are read with the oracle's own key, which is known to be healthy
 * by the time a prompt is handled (`createDecryptor` checks it). So a wrap or a payload that
 * cannot be read is the sender's doing, and is refused as `BadInputError`: dropped, with no
 * alert and no retry. A failure that is the oracle's own is passed on as it is.
 */

const { ethers } = require("ethers");

const { BadInputError, isRetryableError } = require("./errors");
const { errorKind } = require("./errorDescription");

const SESSION_KEY_BYTES = 32;

/**
 * The rule `decryptSymmetrically` uses. A malformed wrap fails inside the ECIES code with a
 * bare Error (a version byte, a length, a point off the curve, a tag that does not match), none
 * of which can be named positively without matching message text. So the other way round: a
 * RangeError is an allocation failure, and an error with a `code` is raised by the runtime;
 * both are the oracle's, and so is an error the oracle has already typed as one to retry. What
 * is left is the sender's.
 */
function isOracleFault(error) {
  return error instanceof RangeError || Boolean(error?.code) || isRetryableError(error);
}

/**
 * The session key a wrap holds.
 *
 * @param {{ decrypt: (cipherBlob: Buffer) => Promise<Buffer> }} decryptor the oracle's own.
 * @param {Buffer} cipherBlob the wrap, as the event carries it.
 * @returns {Promise<Buffer>} 32 bytes.
 * @throws {BadInputError} when the wrap cannot be opened or holds a key of another length.
 */
async function unwrapSessionKey(decryptor, cipherBlob) {
  let sessionKey;
  try {
    sessionKey = await decryptor.decrypt(cipherBlob);
  } catch (error) {
    if (isOracleFault(error)) throw error;
    // The kind only: the message can quote bytes of the wrap.
    const refusal = new BadInputError(
      `Could not open the wrapped session key (${errorKind(error)}).`,
    );
    refusal.wrapNotOpened = true;
    throw refusal;
  }

  // A wrap of any other length opens cleanly and fails later, when the key is first used.
  if (sessionKey.length !== SESSION_KEY_BYTES) {
    throw new BadInputError(
      `The wrapped session key is ${sessionKey.length} bytes, not ${SESSION_KEY_BYTES}.`,
    );
  }

  return sessionKey;
}

/**
 * The payload bytes as text.
 *
 * @param {ethers.BytesLike} payload as the event carries it.
 * @returns {string}
 * @throws {BadInputError} when the bytes are not UTF-8.
 */
function payloadText(payload) {
  try {
    return ethers.toUtf8String(payload);
  } catch (error) {
    // ethers says INVALID_ARGUMENT for bytes that are not UTF-8 or not bytes at all, both of
    // which are what the event carried. Its message quotes the offending bytes, so it goes.
    if (error?.code !== "INVALID_ARGUMENT") throw error;
    throw new BadInputError("The event payload is not UTF-8 text.");
  }
}

/**
 * Whether bad input was a wrap that did not open. One such wrap is the sender's doing; every
 * wrap failing this way is what a dApp wrapping to a key the oracle does not hold looks like,
 * so the caller reports the condition (throttled), never the prompt.
 */
function isWrapNotOpened(error) {
  return error instanceof BadInputError && error.wrapNotOpened === true;
}

module.exports = { unwrapSessionKey, payloadText, isWrapNotOpened };
