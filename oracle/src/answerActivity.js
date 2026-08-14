const { getHandles: getBrainHandles } = require("./brainContext");

/**
 * Oracle-side `senseai.daily_activity` telemetry.
 *
 * A module rather than two inline calls because an answer reaches the chain from two places —
 * `handlePrompt` and `handleRegeneration` — and a regeneration is billed identically, since
 * `submitAnswer` finalises the escrow in the same transaction either way.
 */

/**
 * Kinds the Brain's categoriser buckets for this platform; anything else routes to `unknown` and
 * surfaces in the Slack summary as noise. The Brain exports `OracleActivityKind` for this, but
 * `RecordActivityArgs.kind` is `string`, so the annotation is opt-in and this check is the actual
 * enforcement (CU-86d412qun would make it a compile error).
 *
 * `answer_degraded` is not emitted yet: `isBillable` never leaves the plugin, so the host cannot
 * observe it. Tracked on CU-86d40gvmx.
 */
const ORACLE_KINDS = new Set(["answer", "answer_degraded", "answer_failed"]);

/**
 * Record one answer outcome. Best-effort: never throws, because the escrow has already settled by
 * the time this runs and a telemetry failure must not become the user's problem.
 *
 * @param {object} args
 * @param {bigint|string|number} args.answerMessageId the universal key; also the dedup seed
 * @param {"answer"|"answer_degraded"|"answer_failed"} args.kind
 * @param {string} [args.userWallet]
 * @param {bigint|string|number} [args.conversationId]
 * @param {bigint|string|number} [args.promptMessageId]
 */
async function recordAnswerActivity({
  answerMessageId,
  kind,
  userWallet,
  conversationId,
  promptMessageId,
}) {
  try {
    if (!ORACLE_KINDS.has(kind)) {
      console.warn(`[AnswerActivity] Refusing to record unrecognised kind "${kind}".`);

      return;
    }

    // No timeout here on purpose: the bound lives in brainContext's pool, which sets
    // connectionTimeoutMillis, query_timeout and statement_timeout to 3s. A second timeout here
    // would be a duplicate bound free to drift from it.
    const handles = await getBrainHandles();
    // No Brain configured (localnet / e2e) — not an error.
    if (!handles?.brain?.recordActivity || !handles?.ctx) return;

    await handles.brain.recordActivity(handles.ctx, {
      platform: "oracle",
      kind,
      // `content_hash` is derived from the seed ALONE — platform and kind are not folded in — so
      // the `oracle:` prefix is what stops a collision with a Social row being silently discarded
      // by `onConflictDoNothing` (CU-86d412ugh). The kind is included because a retried prompt can
      // record `answer_failed` and later `answer`, and on the id alone the success would dedup
      // away against the failure.
      contentSeed: `oracle:${kind}:${String(answerMessageId)}`,
      targetId: userWallet ?? null,
      metadata: {
        conversationId: conversationId == null ? null : String(conversationId),
        promptMessageId: promptMessageId == null ? null : String(promptMessageId),
      },
    });
  } catch (error) {
    console.warn(
      `[AnswerActivity] Failed to record ${kind} for ${String(answerMessageId)}: ${String(
        error?.message ?? error,
      )}`,
    );
  }
}

module.exports = { recordAnswerActivity, ORACLE_KINDS };
