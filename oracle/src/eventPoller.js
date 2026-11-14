"use strict";

const { reconcileCursor } = require("./blockCursor");

/**
 * One pass of the poll loop, as a function the caller runs and then sleeps after.
 *
 * A pass reads the chain head and, when it is ahead of the cursor, scans the next range of
 * blocks with one log query, hands every event to its handler, waits for all of them, and only
 * then moves and saves the cursor. Anything that fails before that point leaves the cursor
 * where it was, so the same range is scanned again on the next pass: a refused request can
 * delay an event but cannot skip it. Handlers are idempotent, so a repeat is safe.
 *
 * `tick()` resolves with the milliseconds to wait before the next pass and never rejects:
 *   - the base interval when the pass reached the head;
 *   - a short wait when more ranges are waiting, unless a failure is still being paid off;
 *   - a longer and longer wait while passes fail (see pollBackoff).
 *
 * @param {{
 *   startBlock: number,
 *   batchSize: number,
 *   getHead: () => Promise<number>,
 *   roleReady: () => Promise<void>,
 *   queryEvents: (fromBlock: number, toBlock: number) => Promise<any[]>,
 *   handleEvent: (event: any) => Promise<void>,
 *   persistCursor: (block: number) => Promise<void>,
 *   rewindCursor: (block: number) => Promise<void>,
 *   onReorg?: (info: { head: number, cursor: number, rewoundTo: number }) => any,
 *   outage: { success: () => void, failure: (error: Error) => void },
 *   backoff: { success: () => number, failure: (error: Error) => number, isRaised: () => boolean },
 *   settle?: (tasks: Promise<void>[]) => Promise<void>,
 *   catchUpDelayMs?: number,
 *   log?: { log: Function, warn: Function, error: Function },
 * }} options
 */
function createRangePoller({
  startBlock,
  batchSize,
  getHead,
  roleReady,
  queryEvents,
  handleEvent,
  persistCursor,
  rewindCursor,
  onReorg = () => {},
  outage,
  backoff,
  settle = settleAll,
  catchUpDelayMs = 500,
  log = console,
}) {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error(`eventPoller: batchSize must be a positive whole number, got ${batchSize}`);
  }

  let cursor = startBlock;

  async function reconcileWithHead(head) {
    const rewoundTo = reconcileCursor(cursor, head);
    if (rewoundTo === cursor) return;

    log.warn(
      `  ↩ Chain head ${head} dropped below cursor ${cursor} (reorg/revert) — rewinding cursor to ${rewoundTo}.`,
    );
    // Reporting must not stall or fail the rewind.
    try {
      onReorg({ head, cursor, rewoundTo });
    } catch (error) {
      log.error(`Reorg report failed: ${error.message}`);
    }
    cursor = rewoundTo;
    await rewindCursor(cursor);
  }

  async function pass() {
    // Without the role nothing can be submitted: hold here, cursor where it is, until it is back.
    await roleReady();

    const head = await getHead();
    await reconcileWithHead(head);
    if (head <= cursor) return { reachedHead: true };

    const fromBlock = cursor + 1;
    const toBlock = Math.min(cursor + batchSize, head);

    const events = await queryEvents(fromBlock, toBlock);
    await settle(events.map((event) => handleEvent(event)));

    // Saved even when the range held no events, so an idle chain still moves the cursor.
    cursor = toBlock;
    await persistCursor(cursor);
    outage.success();

    log.log(
      events.length > 0
        ? `  ✓ Polled ${fromBlock} to ${toBlock} -> Processed ${events.length} events.`
        : `  ✓ Polled ${fromBlock} to ${toBlock}`,
    );

    return { reachedHead: toBlock >= head };
  }

  return {
    async tick() {
      try {
        const { reachedHead } = await pass();
        const stillRaised = backoff.isRaised();
        const waitMs = backoff.success();

        // Behind the head: come straight back, unless the provider has just been refusing.
        return !reachedHead && !stillRaised ? catchUpDelayMs : waitMs;
      } catch (error) {
        log.error(`Error in polling loop: ${error.message}`);
        // One failed pass is routine. A loop that keeps failing is stuck on the same range and
        // answering nothing; the outage tracker alerts on that once.
        outage.failure(error);

        return backoff.failure(error);
      }
    },

    /** The last block fully handled. */
    cursor() {
      return cursor;
    },
  };
}

/**
 * Wait for every task, then fail if any failed. Not Promise.all: that rejects on the first
 * failure while the other events are still being answered, and the rescan would start each of
 * them a second time. The oracle passes its own version, which also reports the other failures.
 */
async function settleAll(tasks) {
  const results = await Promise.allSettled(tasks);
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
}

module.exports = { createRangePoller };
