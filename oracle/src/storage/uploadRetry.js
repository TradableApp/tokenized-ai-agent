"use strict";

/**
 * Retry policy for payload uploads to the storage provider.
 *
 * The Autonomys SDK reports an HTTP failure as `Failed to upload file chunk: <statusText>` —
 * words, not a code — and the oracle previously rethrew that untouched. On the 2026-11-09 Base
 * Sepolia run day one chunk of five answered `Service Unavailable`, the handler's classifier
 * recognised neither the words nor the provider, and the paid prompt was dropped as fatal. This
 * module owns two decisions: which failures are worth another attempt, and what to throw when
 * the attempts run out (a RetryableError, so the event is queued rather than declared fatal).
 */

const { RetryableError } = require("../errors");

/** Attempts per upload, including the first. Three covers a blip without stalling the prompt. */
const DEFAULT_ATTEMPTS = 3;
/** Exponential backoff from 1 s, capped at 8 s, plus up to 25% jitter so retries de-correlate. */
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 8_000;
const JITTER_RATIO = 0.25;

/**
 * Failure texts a later attempt may well get past: 5xx and 429 by status text or number, and the
 * socket-level errors a dropped connection produces. Everything else (auth, payload size, credit
 * exhaustion, a bad request) is a configuration or input fault that retrying cannot fix.
 */
const TRANSIENT_PATTERN =
  /service unavailable|bad gateway|gateway time-?out|too many requests|internal server error|\b(429|500|502|503|504)\b|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|socket hang up|fetch failed|network error/i;

function isTransientUploadError(error) {
  return error instanceof Error && TRANSIENT_PATTERN.test(error.message);
}

function backoffDelayMs(attempt, random = Math.random) {
  const base = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);

  return Math.round(base * (1 + JITTER_RATIO * random()));
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `attempt` until it resolves, retrying transient failures with backoff.
 *
 * @param {() => Promise<string>} attempt One upload attempt; resolves to the CID.
 * @param {object} [options]
 * @param {number} [options.attempts] Total attempts including the first.
 * @param {(ms: number) => Promise<void>} [options.sleep] Injected for tests.
 * @param {() => number} [options.random] Injected for deterministic jitter in tests.
 * @param {(error: Error, nextAttemptNumber: number) => void} [options.onRetry] Called before each
 *   retry with the failure and the 1-based number of the attempt about to run (2, 3, …).
 * @returns {Promise<string>} The CID.
 * @throws {RetryableError} every attempt failed transiently (the last failure is `cause`).
 * @throws {Error} the first permanent failure, unchanged, with no further attempts.
 */
async function uploadWithRetry(attempt, options = {}) {
  const {
    attempts = DEFAULT_ATTEMPTS,
    sleep = defaultSleep,
    random = Math.random,
    onRetry = () => {},
  } = options;
  let lastError;

  for (let index = 0; index < attempts; index += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (!isTransientUploadError(error)) {
        throw error;
      }
      lastError = error;
      if (index < attempts - 1) {
        onRetry(error, index + 2);
        await sleep(backoffDelayMs(index, random));
      }
    }
  }

  throw new RetryableError(
    `Autonomys upload failed after ${attempts} attempts: ${lastError.message}`,
    { cause: lastError },
  );
}

module.exports = {
  DEFAULT_ATTEMPTS,
  backoffDelayMs,
  isTransientUploadError,
  uploadWithRetry,
};
