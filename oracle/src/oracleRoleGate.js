"use strict";

/**
 * Holds the oracle's work while its address does not hold the oracle role on the agent contract.
 *
 * Without the role every submission reverts, so answering a prompt would spend model and storage
 * credits on an answer that cannot be delivered. The role can be missing at start-up (the owner
 * has not added this oracle yet) or go missing while running (the owner removed it, or a rotation
 * is under way). Neither is a reason to exit or to drop a prompt: the owner grants the role, and
 * the work carries on from where it stopped.
 *
 *   gate.markLost(error) — a submission was refused, or the start-up check found no role
 *   gate.ready()         — resolves at once while the role is held; otherwise once it is back
 *
 * The chain is only asked while the role is believed lost, once per `recheckMs`.
 *
 * The hooks may be async; whatever they throw or reject with is logged and never reaches the
 * caller.
 *
 * @param {{
 *   checkRole: () => Promise<boolean>,
 *   onLost?: (error?: Error) => any,
 *   onRestored?: () => any,
 *   recheckMs?: number | (() => number),
 *   sleep?: (ms: number) => Promise<void>,
 * }} options
 */
function createRoleGate({
  checkRole,
  onLost = () => {},
  onRestored = () => {},
  recheckMs = 30000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  let lost = false;
  let waiting = null;

  function run(hook, ...args) {
    try {
      Promise.resolve(hook(...args)).catch((error) => {
        console.error(`[OracleRole] hook failed: ${error.message}`);
      });
    } catch (error) {
      console.error(`[OracleRole] hook failed: ${error.message}`);
    }
  }

  async function waitForRole() {
    for (;;) {
      try {
        if (await checkRole()) break;
      } catch (error) {
        // Not knowing is not having: keep holding, and ask again.
        console.warn(`[OracleRole] Could not check the oracle role: ${error.message}`);
      }
      await sleep(typeof recheckMs === "function" ? recheckMs() : recheckMs);
    }
    lost = false;
    run(onRestored);
  }

  return {
    markLost(error) {
      if (lost) return;
      lost = true;
      run(onLost, error);
    },

    isLost() {
      return lost;
    },

    ready() {
      if (!lost) return Promise.resolve();
      if (!waiting) {
        waiting = waitForRole().finally(() => {
          waiting = null;
        });
      }
      return waiting;
    },

    /** Back to "role held", for tests. */
    reset() {
      lost = false;
    },
  };
}

module.exports = { createRoleGate };
