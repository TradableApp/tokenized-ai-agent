/**
 * Which AI tier actually served each answer (CU-86d438hwt).
 *
 * THE FAILURE THIS EXISTS TO CATCH is the one `queryAIModel`'s own comment describes: a retired
 * or misspelled `GOOGLE_*` model id makes Gemini 404 the generateContent call, `queryElizaOS`
 * throws, and the dispatcher falls through to ChainGPT "with no reasoning or sources. The answer
 * degrades silently rather than erroring." It happened, it was fixed, and nothing reported it —
 * every prompt still received an answer, just a materially worse one.
 *
 * Carried in the heartbeat, the tier mix makes that obvious rather than invisible: `elizaos`
 * drops to zero, `chaingpt` jumps, and the shape of the degradation shows up in Slack the same
 * day instead of whenever someone happens to notice the answers got thin.
 *
 * COUNTERS, NOT GAUGES. Cumulative and monotonic, never drained on read. A per-beat tally would
 * lose its whole window every time a beat failed — and beats are explicitly allowed to fail, that
 * being the entire design of the heartbeat loop. With counters, a missed beat costs resolution
 * and never data, because the next beat's totals still include it. Core takes the difference
 * between consecutive beats to get a rate.
 *
 * Counters reset when the process restarts, which is correct and legible: the heartbeat carries
 * `uptimeSeconds` alongside them, so a reset is visible rather than mysterious.
 */

/**
 * The tiers `queryAIModel` can return from, in dispatch order.
 *
 * `none` is a real outcome, not a placeholder: it means every tier failed and the user received
 * the "All AI providers are currently unavailable" string. Without it, a total provider outage
 * would show as zeros across the board — indistinguishable from an hour in which nobody asked
 * anything. Those two must not look the same.
 */
const TIERS = ["tradable", "elizaos", "chaingpt", "deepseek", "mock", "none"];

function createTally() {
  const counts = Object.fromEntries(TIERS.map((t) => [t, 0]));

  return {
    /**
     * Record that `tier` produced an answer. Called from the paid answer path, so it must never
     * throw: an unrecognised tier is ignored rather than raising or creating a bucket on the fly.
     * A silently-invented key would also drift from what core knows how to render.
     */
    recordServed(tier) {
      if (Object.hasOwn(counts, tier)) counts[tier] += 1;
    },

    /** A COPY — a consumer must not be able to reach in and corrupt the counters. */
    snapshot() {
      return { ...counts };
    },
  };
}

/**
 * Module-level singleton. The dispatcher (`aiAgentOracle`) writes and the heartbeat
 * (`oracleHeartbeat`) reads, and they are separate modules with no shared owner to thread an
 * instance through. `createTally` stays exported so tests get a clean instance per case rather
 * than inheriting counts from whatever ran before them.
 */
const providerTally = createTally();

module.exports = { createTally, providerTally, TIERS };
