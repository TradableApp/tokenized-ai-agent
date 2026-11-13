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
 * The chain is only asked while the role is believed lost, once per `recheckMs`. A wait that goes
 * on is reported again every `remindEveryMs`, so a missed first page is not the only signal.
 *
 * The hooks may be async; whatever they throw or reject with is logged and never reaches the
 * caller.
 *
 * @param {{
 *   checkRole: () => Promise<boolean>,
 *   onLost?: (error?: Error) => any,
 *   onRestored?: () => any,
 *   onStillLost?: (info: { waitingForMs: number }) => any,
 *   recheckMs?: number | (() => number),
 *   remindEveryMs?: number,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 * }} options
 */
const DEFAULT_RECHECK_MS = 30 * 1000;
const DEFAULT_REMIND_EVERY_MS = 60 * 60 * 1000;

function createRoleGate({
  checkRole,
  onLost = () => {},
  onRestored = () => {},
  onStillLost = () => {},
  recheckMs = DEFAULT_RECHECK_MS,
  remindEveryMs = DEFAULT_REMIND_EVERY_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
}) {
  let lost = false;
  let waiting = null;
  // Bumped by reset(): a wait started before it no longer speaks for the gate.
  let generation = 0;

  function run(hook, ...args) {
    try {
      Promise.resolve(hook(...args)).catch((error) => {
        console.error(`[OracleRole] hook failed: ${error.message}`);
      });
    } catch (error) {
      console.error(`[OracleRole] hook failed: ${error.message}`);
    }
  }

  // A zero, negative or unparsable interval would turn the wait into a tight loop against the RPC.
  function recheckInterval() {
    const ms = typeof recheckMs === "function" ? recheckMs() : recheckMs;
    return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_RECHECK_MS;
  }

  async function waitForRole(startedIn) {
    const since = now();
    let remindedAt = since;
    for (;;) {
      if (startedIn !== generation) return;
      try {
        if (await checkRole()) break;
      } catch (error) {
        // Not knowing is not having: keep holding, and ask again.
        console.warn(`[OracleRole] Could not check the oracle role: ${error.message}`);
      }
      if (now() - remindedAt >= remindEveryMs) {
        remindedAt = now();
        run(onStillLost, { waitingForMs: remindedAt - since });
      }
      await sleep(recheckInterval());
    }
    if (startedIn !== generation) return;
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
        const wait = waitForRole(generation).finally(() => {
          if (waiting === wait) waiting = null;
        });
        waiting = wait;
      }
      return waiting;
    },

    /** Back to "role held", for tests. */
    reset() {
      // A wait still running belongs to the state being discarded: it ends without a word, and
      // the next loss starts its own.
      generation += 1;
      lost = false;
      waiting = null;
    },
  };
}

module.exports = { createRoleGate };
