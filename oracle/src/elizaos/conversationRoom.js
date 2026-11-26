"use strict";

/**
 * The agent framework's room for one conversation, and keeping it empty between prompts.
 *
 * The framework keeps what a run writes (the history the oracle puts in, the incoming prompt,
 * the replies, facts drawn from them, records of each model call) in its database, which is
 * outside the enclave, and reads a room's messages back into the next prompt it composes there.
 * The oracle rebuilds a conversation's history from storage for every prompt, so a room needs to
 * hold one run only. So:
 *
 * - a room is named for the deployment (chain and agent contract), the conversation and the
 *   wallet that owns it (`conversationScopeKey`), so no two deployments and no two owners share
 *   one, however the conversation numbers repeat;
 * - it is emptied before the history is written into it and again when the run ends
 *   (`clearConversationRoom`), so nothing of a conversation stays in the database between
 *   prompts;
 * - the runs of one room take turns (`withRoomLock`), since a run that ends empties the room
 *   another run of it would still be reading.
 */

const { describeError } = require("../errorDescription");

// Bumped if the parts of the key change, so an old key can never name a new room.
const SCOPE_PREFIX = "senseai-conversation:v1";

// The memory tables the framework writes under a room while it handles a message (@elizaos/core
// and plugin-bootstrap 1.7.2, plugin-mcp): the messages (the history put in, the prompt, every
// reply and action result), the facts the reflection step draws from them, and the records the
// tool plugin keeps of a tool's or a resource's output.
const ROOM_MEMORY_TABLES = Object.freeze(["messages", "facts", "tools", "resources"]);

// The model-call records kept under the agent's own room are removed this many at a time, and
// at most this many pages per clear. A clear runs before and after every run, inside the time a
// paid answer takes, so it stays bounded even when records from before this build are still
// there; the next clear takes the rest. A run leaves a few such records at most.
const AGENT_ROOM_LOG_PAGE = 100;
const AGENT_ROOM_LOG_PAGES = 5;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;

function refuse(field) {
  return new Error(`A conversation's room needs a well-formed ${field}`);
}

/** A whole number in its decimal form, from a bigint, a safe integer or a decimal string. */
function decimal(value, field, { positive }) {
  let text;
  if (typeof value === "bigint") text = value.toString();
  else if (typeof value === "number" && Number.isSafeInteger(value)) text = String(value);
  else if (typeof value === "string") text = value;
  if (text === undefined || !DECIMAL.test(text)) throw refuse(field);
  if (positive && text === "0") throw refuse(field);
  return text;
}

function address(value, field) {
  if (typeof value !== "string" || !ADDRESS.test(value)) throw refuse(field);
  return value.toLowerCase();
}

/**
 * The name of a conversation's place in the agent framework, and of its history at ChainGPT.
 * Pure. Throws when a part is missing or malformed, naming the part and never its value: a part
 * that collapsed to a placeholder would put every conversation it covers in one room.
 *
 * @param {{ chainId: bigint|number|string, agentAddress: string,
 *           conversationId: bigint|number|string, owner: string }} parts
 * @returns {string}
 */
function conversationScopeKey({ chainId, agentAddress, conversationId, owner } = {}) {
  return [
    SCOPE_PREFIX,
    decimal(chainId, "chainId", { positive: true }),
    address(agentAddress, "agentAddress"),
    decimal(conversationId, "conversationId", { positive: false }),
    address(owner, "owner"),
  ].join(":");
}

/** Runs one part of a clear; a failure is recorded by name and does not stop the others. */
async function attempt(failed, part, fn) {
  try {
    await fn();
  } catch (error) {
    failed.push({ part, error });
  }
}

/** Removes the model-call records kept under the agent's own room, a page at a time. */
async function clearAgentRoomLogs(runtime) {
  for (let page = 0; page < AGENT_ROOM_LOG_PAGES; page += 1) {
    const logs = await runtime.getLogs({ roomId: runtime.agentId, count: AGENT_ROOM_LOG_PAGE });
    if (!Array.isArray(logs) || logs.length === 0) return;
    for (const log of logs) await runtime.deleteLog(log.id);
    if (logs.length < AGENT_ROOM_LOG_PAGE) return;
  }
}

/**
 * Empties a conversation's room: each memory table the framework writes under it (with each
 * memory's embedding), then the room itself, which takes its log records, participants and
 * components with it; the reflection marker kept for the room; and the model-call records kept
 * under the agent's own room, where the framework puts a model call made while no run is marked
 * as current, whole prompt included.
 *
 * Never throws: an answer is already paid for and must not be lost to a database that cannot be
 * reached. The parts that failed are printed in one line, each with its error as `describeError`
 * gives it, and their names are returned.
 *
 * @param {object} runtime The agent runtime.
 * @param {string} roomId
 * @param {string} when "before the run" or "after the run", for the printed line.
 * @returns {Promise<string[]>} The parts that could not be cleared; empty when all were.
 */
async function clearConversationRoom(runtime, roomId, when) {
  const failed = [];

  for (const table of ROOM_MEMORY_TABLES) {
    await attempt(failed, table, () => runtime.deleteAllMemories(roomId, table));
  }
  await attempt(failed, "room", () => runtime.deleteRoom(roomId));
  await attempt(failed, "reflection marker", () =>
    runtime.deleteCache(`${roomId}-reflection-last-processed`),
  );
  await attempt(failed, "agent room logs", () => clearAgentRoomLogs(runtime));

  // One line for the clear, each failed part with its error, so a database that cannot be reached
  // prints once per clear and not once per part.
  if (failed.length > 0) {
    const parts = failed.map(({ part, error }) => `${part} (${describeError(error)})`);
    console.error(`[ElizaOS] Could not clear the conversation's room ${when}: ${parts.join("; ")}`);
  }

  return failed.map(({ part }) => part);
}

// The tail of each room's queue of runs. An entry is removed once the last run queued on it ends.
const roomQueues = new Map();

/**
 * Runs `task` once every earlier task for the same room has settled, and gives back its result
 * or its throw. Tasks for other rooms are not held up. A task that throws does not stop the next.
 *
 * @template T
 * @param {string} roomId
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function withRoomLock(roomId, task) {
  const before = roomQueues.get(roomId) ?? Promise.resolve();
  const run = before.then(() => task());
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  roomQueues.set(roomId, tail);
  tail.then(() => {
    if (roomQueues.get(roomId) === tail) roomQueues.delete(roomId);
  });

  return run;
}

module.exports = {
  conversationScopeKey,
  clearConversationRoom,
  withRoomLock,
  ROOM_MEMORY_TABLES,
};
