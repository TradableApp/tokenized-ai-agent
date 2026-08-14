const { getHandles: getBrainHandles } = require("./brainContext");

/**
 * Oracle-side `senseai.daily_activity` telemetry.
 *
 * The Brain owns the writer (`recordActivity`) and the categoriser that buckets these rows; core
 * adopted both and renders them in the Slack daily summary and health check. This is the Oracle
 * body's writer — the last piece of that migration.
 *
 * WHY A MODULE RATHER THAN TWO INLINE CALLS. There are two places an answer reaches the chain,
 * `handlePrompt` and `handleRegeneration`, and their submission blocks are near-identical.
 * Recording at only the first would silently drop every regeneration — which is billed exactly
 * the same, since `submitAnswer` finalises the escrow payment in the same transaction either way.
 */

/**
 * The kinds the Brain's categoriser buckets for this platform. A kind outside this set routes to
 * `unknown` and surfaces in Slack as noise, so a typo is caught here instead of in a daily
 * summary. The Brain exports `OracleActivityKind` for the same purpose, but the guarantee is
 * opt-in on this body — `RecordActivityArgs.kind` is `string`, so nothing forces the annotation.
 * CU-86d412qun would make it a compile error; until then this runtime check is the enforcement.
 *
 * `answer_degraded` is deliberately NOT emitted yet: `isBillable` never leaves the plugin
 * (`queryElizaOS` captures only `{ text, actions }` per emission), so the host cannot observe it
 * without threading a new field through the answer path C1 just stabilised. Tracked on
 * CU-86d40gvmx, which owns what `isBillable` means on this body.
 */
const ORACLE_KINDS = new Set(["answer", "answer_degraded", "answer_failed"]);

/**
 * Record one answer outcome. Best-effort and silent by contract — see the catch.
 *
 * @param {object} args
 * @param {bigint|string|number} args.answerMessageId the universal key; also the dedup seed
 * @param {"answer"|"answer_degraded"|"answer_failed"} args.kind
 * @param {string} [args.userWallet] the prompting wallet
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
      console.warn(
        `[AnswerActivity] Refusing to record unrecognised kind "${kind}" — it would surface in Slack as an unknown activity kind.`,
      );

      return;
    }

    // WHY THERE IS NO TIMEOUT HERE. A try/catch bounds rejections, not stalls — so a hung await
    // would hold a p-queue slot (concurrency 5) forever, and on the failure path would stop the
    // rethrow that lets handleAndRecord retry. That bound exists, one layer down and not in this
    // file: brainContext's pool sets connectionTimeoutMillis, query_timeout AND statement_timeout
    // to QUERY_TIMEOUT_MS (3s), covering waiting for a connection, the client-side query and the
    // server-side statement. getBrainHandles itself opens no socket — its only await is the
    // dynamic import of the Brain.
    //
    // Wrapping a second timeout around it here would be a duplicate bound with its own constant,
    // free to drift from the pool's and to disagree about which one fired. If that ever needs
    // changing, change it at the pool.
    const handles = await getBrainHandles();
    // No Brain at all (localnet / e2e). Not an error: those runs have no shared cache.
    if (!handles?.brain?.recordActivity || !handles?.ctx) return;

    await handles.brain.recordActivity(handles.ctx, {
      platform: "oracle",
      kind,
      // TRAP: prefix REQUIRED. `content_hash` is derived from this seed alone — platform and kind
      // are deliberately not folded in — so an unprefixed seed can collide with a Social row and
      // be silently discarded by `onConflictDoNothing`. See recordActivity's docstring and
      // CU-86d412ugh.
      //
      // The KIND is in the seed too, and not merely for symmetry with core's
      // `twitter:<user>:broadcast:<text>`. handleAndRecord retries failed jobs, so one answer can
      // legitimately produce `answer_failed` and later `answer`. On the answerMessageId alone
      // those hash identically and the SECOND — the successful one — is silently dropped, leaving
      // a permanent failure for a prompt that was in fact answered. Retrying the SAME outcome
      // still dedups, which is correct: one failure per answer, not one per attempt.
      contentSeed: `oracle:${kind}:${String(answerMessageId)}`,
      targetId: userWallet ?? null,
      metadata: {
        conversationId: conversationId == null ? null : String(conversationId),
        promptMessageId: promptMessageId == null ? null : String(promptMessageId),
      },
    });
  } catch (error) {
    // NEVER propagate. This sits on a paid, immutable answer path: the escrow has already moved
    // by the time we record, so a telemetry failure must not become the user's problem. The
    // Brain's writer is best-effort too, but this body does not rely on that — a change there
    // must not be able to start failing charged prompts from here.
    console.warn(
      `[AnswerActivity] Failed to record ${kind} for ${String(answerMessageId)}: ${String(
        error?.message ?? error,
      )}`,
    );
  }
}

module.exports = { recordAnswerActivity, ORACLE_KINDS };
