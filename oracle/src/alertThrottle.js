"use strict";

/**
 * Sends one alert of a kind per interval, for a condition reported once per event. A backlog of
 * events would otherwise be one Slack message (and one email on mainnet) per event, saying the
 * same thing each time.
 *
 * @param {{ intervalMs: number, now?: () => number }} options
 * @returns {{ shouldSend: () => boolean }} true for the first call, then once the interval has
 *          passed since the last call that returned true.
 */
function createAlertThrottle({ intervalMs, now = Date.now }) {
  let lastSentAt = null;

  return {
    shouldSend() {
      const at = now();
      if (lastSentAt !== null && at - lastSentAt < intervalMs) return false;
      lastSentAt = at;

      return true;
    },
  };
}

module.exports = { createAlertThrottle };
