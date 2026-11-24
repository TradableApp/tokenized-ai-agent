const { errorKind } = require("../errorDescription");

/**
 * Tells someone when reasoning thoughts are being dropped.
 *
 * A dropped thought costs the answer nothing, which is why nothing would otherwise notice it: the
 * stored answer simply has less reasoning, or none. The heartbeat counts drops by kind
 * (`stream.thoughtsDropped`); this alerts on the kinds that mean something is wrong, the first
 * time each happens in a process and again at most once an hour while it goes on. By kind only,
 * never an id or anything of a thought.
 *
 * `refused` is not alerted: it is the Brain's sanitiser doing its job.
 */

const THOUGHT_DROP_ALERT_KINDS = Object.freeze(["unavailable", "timeout", "failed", "late"]);
const THOUGHT_DROP_ALERT_REPEAT_MS = 60 * 60 * 1000;

const WHAT_IT_MEANS = {
  unavailable: "the Brain's sanitiser could not be loaded",
  timeout: "the Brain's sanitiser did not answer in time",
  failed: "the Brain's sanitiser failed",
  late: "steps landed after their answer's reasoning had been read",
};

/**
 * @param {object} deps
 * @param {(title: string, message: string) => unknown} deps.alert e.g. `alerting.sendAlert`
 * @param {() => number} [deps.now]
 * @param {number} [deps.repeatAfterMs]
 * @returns {(kind: string) => void} never throws
 */
function createThoughtDropAlerter({
  alert,
  now = Date.now,
  repeatAfterMs = THOUGHT_DROP_ALERT_REPEAT_MS,
}) {
  const lastAlertAt = new Map();

  function report(error) {
    console.error(`[Stream] The thought drop alert could not be sent (${errorKind(error)}).`);
  }

  return function onThoughtDropped(kind) {
    if (!THOUGHT_DROP_ALERT_KINDS.includes(kind)) return;
    const at = now();
    const last = lastAlertAt.get(kind);
    if (last !== undefined && at - last < repeatAfterMs) return;
    lastAlertAt.set(kind, at);
    try {
      const sent = alert(
        "Oracle: reasoning thoughts are being dropped",
        `Reasoning thoughts are being dropped (kind: ${kind}): ${WHAT_IT_MEANS[kind]}. ` +
          "Answers are not affected, and what is stored still equals what was streamed, but " +
          "answers carry less reasoning or none. The heartbeat counts drops by kind under " +
          "stream.thoughtsDropped. This alert repeats at most once an hour per kind.",
      );
      if (sent && typeof sent.then === "function") sent.then(undefined, report);
    } catch (error) {
      report(error);
    }
  };
}

module.exports = {
  createThoughtDropAlerter,
  THOUGHT_DROP_ALERT_KINDS,
  THOUGHT_DROP_ALERT_REPEAT_MS,
};
