"use strict";

/**
 * Turns a run of failures into exactly one alert, and its end into exactly one recovery notice.
 *
 * The oracle deliberately absorbs some failures so it can keep answering prompts — a cursor write
 * that fails, a retry queue that cannot be read. Absorbed and unreported, those leave an oracle
 * that looks healthy while it is losing its place. Reported on every occurrence, they would page
 * someone every few seconds. This sits between the two.
 *
 *   tracker.failure(error)  — call on each failure; alerts once the run has lasted `alertAfterMs`
 *   tracker.success()       — call on each success; reports recovery if a run was in progress
 *
 * The hooks may be async; whatever they throw or reject with is logged and never reaches the
 * caller, which is on the oracle's hot path.
 *
 * @param {{
 *   alertAfterMs: number,
 *   onAlert: (error: Error, info: { failingForMs: number, failures: number }) => any,
 *   onRecover?: (info: { failedForMs: number, failures: number, alerted: boolean }) => any,
 *   now?: () => number,
 * }} options
 */
function createOutageTracker({ alertAfterMs, onAlert, onRecover = () => {}, now = Date.now }) {
  let failingSince = null;
  let failures = 0;
  let alerted = false;

  function run(hook, ...args) {
    try {
      Promise.resolve(hook(...args)).catch((error) => {
        console.error(`[OutageTracker] hook failed: ${error.message}`);
      });
    } catch (error) {
      console.error(`[OutageTracker] hook failed: ${error.message}`);
    }
  }

  return {
    failure(error) {
      const at = now();
      if (failingSince === null) failingSince = at;
      failures += 1;

      const failingForMs = at - failingSince;
      if (!alerted && failingForMs >= alertAfterMs) {
        alerted = true;
        run(onAlert, error, { failingForMs, failures });
      }
    },

    success() {
      if (failingSince === null) return;
      const info = { failedForMs: now() - failingSince, failures, alerted };
      failingSince = null;
      failures = 0;
      alerted = false;
      run(onRecover, info);
    },

    /** True while a run of failures is in progress. */
    isFailing() {
      return failingSince !== null;
    },
  };
}

module.exports = { createOutageTracker };
