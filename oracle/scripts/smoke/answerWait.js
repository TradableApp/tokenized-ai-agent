/**
 * Discover a prompt's AnswerMessageAdded event with eth_getLogs, within the block-range caps RPC
 * providers impose on that call.
 *
 * Providers cap the range of one eth_getLogs request: Alchemy's free tier at 10 blocks, the public
 * Base Sepolia node at a few hundred. The 2026-11-02 run day asked for [submitBlock, head] in one
 * request through an Alchemy endpoint, was refused on every poll, logged only ethers' wrapper text
 * ("could not coalesce error"), never advanced, and timed out — while the oracle had answered all
 * five prompts on-chain within a minute. Three rules follow:
 *
 *   1. walk [from, head] in contiguous chunks of at most cfg.logsBlockRange blocks;
 *   2. advance `from` only past chunks that were actually read, so a refused call is retried from
 *      where it failed, never from the original submit block (which would re-widen the window);
 *   3. log the node's own JSON-RPC error, and name the last one in the TIMEOUT.
 *
 * Returns EVERY matching event in the chunk the answer appeared in, so burst mode can tell one
 * answer from two. The answer always lands after the submit block, so the scan starts there.
 */

/** The node's own error message when ethers wrapped one; ethers' or a plain message otherwise. */
function rpcErrorMessage(e) {
  const rpc = e?.error ?? e?.info?.error;
  if (rpc?.message)
    return rpc.code !== undefined ? `${rpc.message} (code ${rpc.code})` : rpc.message;
  return String(e?.shortMessage || e?.message || e);
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} args
 * @param {import("ethers").Contract} args.agent
 * @param {{getBlockNumber(): Promise<number>}} args.provider
 * @param {bigint|number|string} args.conversationId
 * @param {bigint|number|string} args.answerMessageId
 * @param {number} args.fromBlock  the initiatePrompt receipt's block
 * @param {{timeoutMs: number, pollMs: number, logsBlockRange: number}} args.cfg
 * @param {(line: string) => void} [args.log]
 * @param {() => number} [args.now]
 * @param {(ms: number) => Promise<void>} [args.sleep]
 * @returns {Promise<import("ethers").EventLog[]>}
 */
async function waitForAnswer({
  agent,
  provider,
  conversationId,
  answerMessageId,
  fromBlock,
  cfg,
  log = () => {},
  now = Date.now,
  sleep = defaultSleep,
}) {
  const deadline = now() + cfg.timeoutMs;
  const filter = agent.filters.AnswerMessageAdded(conversationId, answerMessageId);
  const range = Math.max(1, Math.floor(cfg.logsBlockRange));
  let from = fromBlock;
  let lastRpcError;

  while (now() < deadline) {
    try {
      const head = await provider.getBlockNumber();
      // Re-check the clock per chunk: a long catch-up (provider back after an outage) must not
      // drain every chunk past the deadline before the outer loop looks at it again.
      while (from <= head && now() < deadline) {
        const to = Math.min(head, from + range - 1);
        let evts;
        try {
          evts = await agent.queryFilter(filter, from, to);
        } catch (e) {
          lastRpcError = rpcErrorMessage(e);
          log(`eth_getLogs refused for blocks ${from}-${to}: ${lastRpcError} — retrying next poll`);
          break; // keep `from` where it is: this chunk has not been read
        }
        if (evts.length) return evts;
        from = to + 1;
      }
      // Informational only — a transient failure here must not abort the poll.
      try {
        if (await agent.isJobFinalized(answerMessageId))
          log(`job finalized; awaiting AnswerMessageAdded...`);
      } catch {
        /* ignore — status log only */
      }
    } catch (e) {
      // getBlockNumber: a transient blip or rate-limit must not fail the run — retry next poll.
      lastRpcError = rpcErrorMessage(e);
      log(`transient RPC error (${lastRpcError}) — retrying...`);
    }
    await sleep(cfg.pollMs);
  }
  throw new Error(
    `TIMEOUT: no AnswerMessageAdded for answerMessageId=${answerMessageId} within ${cfg.timeoutMs / 1000}s` +
      (lastRpcError ? ` (last RPC error: ${lastRpcError})` : ""),
  );
}

module.exports = { waitForAnswer, rpcErrorMessage };
