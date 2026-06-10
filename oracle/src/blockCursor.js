"use strict";

/**
 * Reconcile the event-polling cursor against the current chain head.
 *
 * The poll loop normally advances monotonically: it scans `[cursor+1 .. head]`
 * whenever the head moves ahead. But if the head drops *below* the cursor — a
 * chain reorg (shallow reorgs do happen on Base) or a localnet Hardhat
 * `evm_revert` — the blocks we thought we had processed no longer exist. Left
 * unhandled, the monotonic cursor would wait for the head to climb back past its
 * old value and silently skip every re-mined block in between, so events
 * (PromptSubmitted, etc.) re-mined after the reorg are never processed.
 *
 * On a detected drop we rewind to just below the new head (`head - 1`, clamped at
 * 0) so the very next poll re-scans from the new head onward. Returns the cursor
 * the caller should use for the next poll.
 *
 * @param {number} currentBlock - The last block the oracle believes it processed.
 * @param {number} latestBlock - The current chain head.
 * @returns {number} The (possibly rewound) cursor for the next poll.
 */
function reconcileCursor(currentBlock, latestBlock) {
  if (latestBlock < currentBlock) {
    return Math.max(0, latestBlock - 1);
  }

  return currentBlock;
}

module.exports = { reconcileCursor };
