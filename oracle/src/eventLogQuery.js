"use strict";

/**
 * The events that ask the oracle for work, and one log query that finds all of them.
 *
 * The poll loop used to make one `eth_getLogs` call per event type, four per pass. A topic
 * filter may name several signatures in the same position, so one call returns all four.
 */
const ORACLE_WORK_EVENTS = Object.freeze([
  "PromptSubmitted",
  "RegenerationRequested",
  "BranchRequested",
  "MetadataUpdateRequested",
]);

/**
 * A topic filter matching any oracle-work event: topic 0 is one of the four signatures.
 * @param {{ interface: import("ethers").Interface }} contract
 * @returns {string[][]}
 */
function oracleWorkTopicFilter(contract) {
  return [ORACLE_WORK_EVENTS.map((name) => contract.interface.getEvent(name).topicHash)];
}

/** Chain order: by block, then by the log's position in the block. */
function compareLogOrder(a, b) {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;

  return a.index - b.index;
}

/**
 * Every oracle-work event in `[fromBlock, toBlock]`, in chain order, from a single query.
 *
 * The caller keeps the range inside the provider's limit; a failed query is thrown to it.
 *
 * A log that matched the filter but could not be decoded is left out and handed to
 * `onUndecodable`. ethers returns such a log, with no event name, when the ABI in use does not
 * fit the deployed contract (an `indexed` flag that differs is enough, since it is not part of
 * the signature). The caller's cursor moves past it, so the report is the only trace of it.
 *
 * @param {import("ethers").Contract} contract
 * @param {number} fromBlock
 * @param {number} toBlock
 * @param {{ onUndecodable?: (log: any) => any }} [options]
 * @returns {Promise<import("ethers").EventLog[]>}
 */
async function queryOracleWorkEvents(contract, fromBlock, toBlock, { onUndecodable } = {}) {
  const logs = await contract.queryFilter(oracleWorkTopicFilter(contract), fromBlock, toBlock);

  const named = logs.filter((log) => {
    if (log.eventName) return true;

    console.warn(
      `[Poll] A log in block ${log.blockNumber} (tx ${log.transactionHash}, log ${log.index}) matched the oracle-work filter but could not be decoded; skipped.`,
    );
    // The report may throw or return a promise that rejects; neither may lose the other events.
    const reportFailed = (error) =>
      console.error(`[Poll] Reporting an undecodable log failed: ${error?.message}`);
    try {
      Promise.resolve(onUndecodable?.(log)).catch(reportFailed);
    } catch (error) {
      reportFailed(error);
    }

    return false;
  });

  return named.sort(compareLogOrder);
}

module.exports = {
  ORACLE_WORK_EVENTS,
  compareLogOrder,
  oracleWorkTopicFilter,
  queryOracleWorkEvents,
};
