/**
 * Oracle liveness heartbeat (CU-86d438hwt).
 *
 * Writes one `platform: "oracle"`, `kind: "heartbeat"` row on a background timer, carrying the
 * vitals snapshot as metadata. Core reads the newest one and checks its AGE: staleness is the
 * signal. This is what `daily_activity` could not previously express — a silent oracle and a
 * healthy-but-idle one both produce zero answer rows.
 *
 * DELIBERATELY OFF THE PROMPT PATH. It is a standalone timer with no relationship to
 * `handlePrompt`. Telemetry must never be able to affect an answer someone has already paid for
 * on-chain, and the cleanest way to guarantee that is for the two to never touch.
 *
 * A LIVENESS BEACON THAT CAN DIE IS WORSE THAN NONE. If one bad beat stops the loop, core sees
 * staleness and reports the oracle DEAD while it is answering prompts perfectly well. Whoever is
 * paged learns the alert lies, and ignores the next real outage. Every design choice below serves
 * keeping the chain alive.
 */

const { randomUUID } = require("node:crypto");

/** 15 minutes. Overridable per environment — testnet TEEs are short-lived, mainnet is not. */
const DEFAULT_INTERVAL_MS = 900000;

function resolveIntervalMs(explicit) {
  // `Number.isFinite`, not `typeof === "number"`: NaN IS a number in JS, so a typeof check
  // returns NaN early and skips the env fallback entirely. The caller's guard catches it and
  // disables the beat, but silently — a caller passing NaN deserves the env default, not a
  // dead heartbeat.
  if (Number.isFinite(explicit)) return explicit;
  const raw = Number.parseInt(process.env.ORACLE_HEARTBEAT_INTERVAL_MS ?? "", 10);

  return Number.isFinite(raw) ? raw : DEFAULT_INTERVAL_MS;
}

/**
 * Start the heartbeat chain.
 *
 * @param {object} opts
 * @param {Function} opts.recordActivity - the Brain's writer, `(ctx, args) => Promise<void>`
 * @param {object} opts.ctx - BrainContext pointed at the SHARED `senseai` DB (not `oracle_agent`)
 * @param {Function} opts.collect - resolves the vitals snapshot
 * @param {number} [opts.intervalMs] - defaults to ORACLE_HEARTBEAT_INTERVAL_MS, then 15 min
 * @param {object} [opts.logger] - anything with `warn`
 * @returns {{ stop: Function }}
 */
function startHeartbeat({ recordActivity, ctx, collect, intervalMs, logger = console }) {
  const period = resolveIntervalMs(intervalMs);
  let timer = null;
  let stopped = false;

  // A non-positive interval means "off". Without this guard, setTimeout(fn, 0) becomes a spin
  // loop that writes continuously — a config typo would flood the shared table.
  if (!Number.isFinite(period) || period <= 0) {
    logger.warn?.(`[Heartbeat] Disabled — interval ${period} is not a positive number.`);

    return { stop() {} };
  }

  async function beat() {
    // EVERYTHING inside the try, collector included. The collector is written not to throw, but
    // relying on that here would make this loop's survival depend on another module keeping a
    // promise. Defence in depth is cheap; a dead beacon is not.
    try {
      const vitals = await collect();

      await recordActivity(ctx, {
        platform: "oracle",
        kind: "heartbeat",
        // MUST be unique per beat. `content_hash` derives from the seed alone and the writer uses
        // onConflictDoNothing, so a constant seed means every beat after the first is silently
        // discarded — and the heartbeat then looks permanently stale, which is the exact false
        // alarm this whole feature exists to avoid. A UUID rather than a timestamp because two
        // beats can share a millisecond after a clock adjustment.
        contentSeed: `oracle:heartbeat:${randomUUID()}`,
        targetId: null,
        metadata: vitals,
      });
    } catch (error) {
      // Stack included, not just the message. `oasis rofl machine logs` is the ONLY debugging
      // window into a running TEE, and "connection reset" without a frame does not say whether
      // it came from the RPC, Auto-Drive, or the Postgres write — three different fixes.
      logger.warn?.(
        `[Heartbeat] Beat failed: ${String(error?.stack ?? error?.message ?? error)}`,
      );
    }
  }

  function schedule() {
    if (stopped) return;
    timer = setTimeout(run, period);
    // Do not hold the process open purely to emit telemetry.
    timer.unref?.();
  }

  async function run() {
    // `beat()` cannot reject — it swallows everything — but the reschedule lives in `finally`
    // regardless, so the chain survives even if that ever stops being true.
    try {
      await beat();
    } finally {
      schedule();
    }
  }

  // CHAINED setTimeout, not setInterval. setInterval fires whether or not the previous beat
  // finished, so a write slower than the interval stacks overlapping beats against the same
  // pool; and an async interval handler that rejects raises an unhandled rejection, which under
  // Node's default `--unhandled-rejections=throw` kills the oracle — taking down the paid answer
  // path in order to report on it. Chaining makes overlap structurally impossible: the next beat
  // is only scheduled once the current one has settled.
  schedule();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/**
 * Assemble the real dependencies and start the chain.
 *
 * Separated from `startHeartbeat` so the timer stays a pure, fully injectable unit and the
 * environment-specific plumbing is the only part that needs the app's singletons.
 *
 * THE DATABASE IS THE TRAP HERE. `runtime.db` is plugin-sql's, pointed at the isolated
 * `oracle_agent`; the Brain's `ctx.db` is the SHARED `senseai` DB where `daily_activity` lives
 * and where core's daily summary reads. Writing through the former succeeds, looks perfectly
 * healthy, and lands somewhere core will never look — so the heartbeat would be invisible while
 * appearing to work. Always the Brain's ctx.
 */
async function startOracleHeartbeat(opts = {}) {
  const { getHandles } = require("./brainContext");
  const { collectVitals } = require("./oracleVitals");
  const { providerTally } = require("./providerTally");
  const { logger = console } = opts;

  // Distinguish "no Brain configured" from "Brain FAILED to initialise". Both end with the beat
  // disabled, but only one is normal: a credential error or a network timeout during Brain setup
  // would otherwise log "not configured" and look like an intentional localnet run, hiding a real
  // fault behind a reassuring message.
  const handles = await getHandles().catch((error) => {
    logger.warn?.(
      `[Heartbeat] Brain handles failed to resolve: ${String(error?.message ?? error)}`,
    );

    return null;
  });

  // No Brain configured (localnet / e2e) — not an error, and not a reason to crash the oracle.
  // Same posture as answerActivity: telemetry is optional, answering prompts is not.
  if (!handles?.brain?.recordActivity || !handles?.ctx) {
    logger.warn?.("[Heartbeat] Brain unavailable — liveness beat disabled.");

    return { stop() {} };
  }

  return startHeartbeat({
    recordActivity: handles.brain.recordActivity,
    ctx: handles.ctx,
    collect: () => collectVitals({ providerTally, ...opts }),
    intervalMs: opts.intervalMs,
    logger,
  });
}

module.exports = { startHeartbeat, startOracleHeartbeat, DEFAULT_INTERVAL_MS };
