"use strict";

/**
 * How long the poll loop waits before its next pass.
 *
 * While passes succeed the wait is the base interval. A failed pass (a refused request, an RPC
 * error) doubles it, up to a cap, so a provider that is rate-limiting is asked less often rather
 * than at the same pace. Recovery is gradual: each success removes half of what is above the
 * base, so one good answer from a provider that has just been refusing does not send the loop
 * straight back to full speed.
 *
 * Pure: no timers and no clock. The caller sleeps for the number of milliseconds returned.
 *
 * @param {{ baseMs: number, capMs: number }} options
 */
function createPollBackoff({ baseMs, capMs }) {
  if (!Number.isFinite(baseMs) || baseMs <= 0) {
    throw new Error(`pollBackoff: baseMs must be a positive number, got ${baseMs}`);
  }
  if (!Number.isFinite(capMs) || capMs < baseMs) {
    throw new Error(`pollBackoff: capMs must be a number at or above baseMs, got ${capMs}`);
  }

  let waitMs = baseMs;

  return {
    /** A pass succeeded: step back towards the base. Returns the wait before the next pass. */
    success() {
      // Below one millisecond of excess the halving would never reach the base.
      const excess = Math.floor((waitMs - baseMs) / 2);
      waitMs = baseMs + excess;

      return waitMs;
    },

    /**
     * A pass failed: double the wait, and wait at least as long as the provider asked.
     * @param {unknown} [error] The failure; a Retry-After on its HTTP response is honoured.
     */
    failure(error) {
      waitMs = Math.min(capMs, Math.max(waitMs * 2, retryAfterMs(error)));

      return waitMs;
    },

    /** The wait as it stands, unchanged. */
    current() {
      return waitMs;
    },

    /** True while the wait is above the base, that is, while a failure is still being paid off. */
    isRaised() {
      return waitMs > baseMs;
    },
  };
}

/**
 * The Retry-After a provider sent with a refusal, in milliseconds; 0 when there is none.
 *
 * ethers attaches the HTTP response to the error it throws (`error.info.response`, headers in
 * lower case). Only the whole-seconds form is read; the HTTP-date form falls back to the doubled
 * wait.
 *
 * @param {any} error
 * @returns {number}
 */
function retryAfterMs(error) {
  const value = error?.info?.response?.headers?.["retry-after"];
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return 0;

  return Number(value.trim()) * 1000;
}

module.exports = { createPollBackoff, retryAfterMs };
