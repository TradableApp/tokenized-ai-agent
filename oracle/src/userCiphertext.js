"use strict";

/**
 * Reading what a prompt's sender controls: the session key wrapped to the oracle's public key,
 * and the payload bytes. A wrap or a payload that cannot be read is refused as `BadInputError`:
 * dropped, with no alert of its own and no retry. Each refusal carries its kind
 * (`unreadableKind`), so the caller can count them (promptReadTally.js). A failure that is the
 * oracle's own is passed on as it is.
 *
 * Nothing here can tell a sender's bad wrap from a wrap made to a key this oracle does not hold:
 * `createDecryptor` checks only that the key is 32 bytes, and nothing compares it with the key
 * the dApp encrypts to. That is what the counts are for: when no prompt is read at all, the
 * notice is CRITICAL and names that key as the thing to check.
 */

const { ethers } = require("ethers");

const { BadInputError, isRetryableError } = require("./errors");
const { errorKind } = require("./errorDescription");
const { UNREADABLE } = require("./promptReadTally");

const SESSION_KEY_BYTES = 32;

/** A `BadInputError` for a prompt that could not be read, carrying its kind. */
function unreadablePrompt(kind, message, options) {
  const error = new BadInputError(message, options);
  error.unreadablePrompt = kind;

  return error;
}

/** The kind of a prompt that could not be read, or null for any other error. */
function unreadableKind(error) {
  if (!(error instanceof BadInputError)) return null;

  return Object.values(UNREADABLE).includes(error.unreadablePrompt) ? error.unreadablePrompt : null;
}

/**
 * The rule `decryptSymmetrically` uses. A malformed wrap fails inside the ECIES code with a
 * bare Error (a version byte, a length, a point off the curve, a tag that does not match), none
 * of which can be named positively without matching message text. So the other way round: a
 * RangeError is an allocation failure, an error with a `code` is raised by the runtime, and a
 * TypeError, ReferenceError or SyntaxError is a mistake in code (the oracle's, or a library's
 * after an upgrade); all are the oracle's, and so is an error the oracle has already typed as one
 * to retry. What is left is the sender's. The one input that made the ECIES code throw a
 * TypeError, an empty wrap, is refused before it is called.
 */
const PROGRAMMING_ERRORS = [RangeError, TypeError, ReferenceError, SyntaxError];

function isOracleFault(error) {
  return (
    PROGRAMMING_ERRORS.some((Type) => error instanceof Type) ||
    Boolean(error?.code) ||
    isRetryableError(error)
  );
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
  if (!cipherBlob || cipherBlob.length === 0) {
    throw unreadablePrompt(UNREADABLE.wrapNotOpened, "The wrapped session key is empty.");
  }

  let sessionKey;
  try {
    sessionKey = await decryptor.decrypt(cipherBlob);
  } catch (error) {
    if (isOracleFault(error)) throw error;
    // The kind only: the message can quote bytes of the wrap.
    throw unreadablePrompt(
      UNREADABLE.wrapNotOpened,
      `Could not open the wrapped session key (${errorKind(error)}).`,
    );
  }

  // A wrap of any other length opens cleanly and fails later, when the key is first used.
  if (sessionKey.length !== SESSION_KEY_BYTES) {
    throw unreadablePrompt(
      UNREADABLE.keyWrongLength,
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
    throw unreadablePrompt(UNREADABLE.payloadNotUtf8, "The event payload is not UTF-8 text.");
  }
}

module.exports = { unwrapSessionKey, payloadText, unreadablePrompt, unreadableKind };
