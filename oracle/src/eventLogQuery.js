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
 * @param {import("ethers").Contract} contract
 * @param {number} fromBlock
 * @param {number} toBlock
 * @returns {Promise<import("ethers").EventLog[]>}
 */
async function queryOracleWorkEvents(contract, fromBlock, toBlock) {
  const logs = await contract.queryFilter(oracleWorkTopicFilter(contract), fromBlock, toBlock);

  // ethers returns a bare Log, with no event name, for a topic its interface cannot decode.
  // The filter only asks for signatures taken from that interface, so this is not expected.
  const named = logs.filter((log) => {
    if (log.eventName) return true;
    console.warn(
      `[Poll] A log in block ${log.blockNumber} matched the oracle-work filter but could not be decoded; skipped.`,
    );

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
