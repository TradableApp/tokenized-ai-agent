"use strict";

/**
 * The agent framework's room for one conversation, and keeping it empty between prompts.
 *
 * The framework keeps what a run writes (the history the oracle puts in, the incoming prompt,
 * the replies and action results) in its database, which is outside the enclave, and reads a
 * room's messages back into the next prompt it composes there. The oracle rebuilds a
 * conversation's history from storage for every prompt, so a room needs to hold one run only.
 * So:
 *
 * - a room is named for the deployment (chain and agent contract), the conversation and the
 *   wallet that owns it (`conversationScopeKey`), so no two deployments and no two owners share
 *   one, however the conversation numbers repeat; the owner's entity in it is named from the same
 *   key, so it is the room's alone;
 * - it is emptied before the history is written into it and again when the run ends
 *   (`clearConversationRoom`), entity included, so nothing of a conversation stays in the
 *   database between prompts (what the framework would derive for later is not written at all:
 *   see agentMemory.js);
 * - the runs of one room take turns (`withRoomLock`), since a run that ends empties the room
 *   another run of it would still be reading, and a room's prompts wait for their turn before they
 *   take a place in the oracle's work queue (`takeRoomTurn`), so the ones waiting hold none.
 */

const { describeError } = require("../errorDescription");
const { ROOM_MEMORY_TABLES } = require("./agentMemory");

// Bumped if the parts of the key change, so an old key can never name a new room.
const SCOPE_PREFIX = "senseai-conversation:v1";

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

/**
 * Empties a conversation's room: each memory table the framework writes under it (with each
 * memory's embedding), then the room itself, which takes its log records, participants and
 * components with it, then the owner's entity of the room (`entityId`) with its components.
 * Nothing else of a run is kept to be cleared: see agentMemory.js.
 *
 * Never throws: an answer is already paid for and must not be lost to a database that cannot be
 * reached. The parts that failed are printed in one line, each with its error as `describeError`
 * gives it, and their names are returned.
 *
 * @param {object} runtime The agent runtime.
 * @param {{ roomId: string, entityId: string }} room
 * @param {string} when "before the run" or "after the run", for the printed line.
 * @returns {Promise<string[]>} The parts that could not be cleared; empty when all were.
 */
async function clearConversationRoom(runtime, { roomId, entityId }, when) {
  const failed = [];

  for (const table of ROOM_MEMORY_TABLES) {
    await attempt(failed, table, () => runtime.deleteAllMemories(roomId, table));
  }
  await attempt(failed, "room", () => runtime.deleteRoom(roomId));
  await attempt(failed, "entity", () => runtime.adapter.deleteEntity(entityId));

  // One line for the clear, each failed part with its error, so a database that cannot be reached
  // prints once per clear and not once per part.
  if (failed.length > 0) {
    const parts = failed.map(({ part, error }) => `${part} (${describeError(error)})`);
    console.error(`[ElizaOS] Could not clear the conversation's room ${when}: ${parts.join("; ")}`);
  }

  return failed.map(({ part }) => part);
}

function noop() {}

/**
 * Runs `task` on `queues`' chain for `key`: once every earlier task there, and whatever each of
 * them held the key for, has settled. `task` is given `hold(promise)`, which keeps the key taken
 * after the task itself has settled, until `promise` has too. An entry is removed once nothing is
 * queued on it.
 */
function chained(queues, key, task) {
  const before = queues.get(key) ?? Promise.resolve();
  const holds = [];
  const hold = (promise) => {
    holds.push(Promise.resolve(promise).then(noop, noop));
  };
  const run = before.then(() => task(hold));
  const tail = run
    .then(noop, noop)
    .then(() => Promise.all(holds))
    .then(noop);
  queues.set(key, tail);
  tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });

  return run;
}

// The tail of each room's runs, and of each room's turns at the work queue.
const roomLocks = new Map();
const roomTurns = new Map();

/**
 * Runs `task` once every earlier task for the same room, and whatever each held the room for, has
 * settled, and gives back its result or its throw. Tasks for other rooms are not held up. A task
 * that throws does not stop the next. `task` is given `hold(promise)`: the room stays taken until
 * that promise settles too, while the task's result goes back at once.
 *
 * Within this process only: two processes on one agent database do not see each other's locks.
 *
 * @template T
 * @param {string} roomId
 * @param {(hold: (promise: Promise<unknown>) => void) => Promise<T>} task
 * @returns {Promise<T>}
 */
function withRoomLock(roomId, task) {
  return chained(roomLocks, roomId, task);
}

/**
 * Gives a room's work its turn: `enter` is called once the room's earlier work has been through
 * and the room's lock is free, so a prompt waiting on another of its room takes no place in the
 * work queue while it waits. Gives back what `enter` gives.
 *
 * @template T
 * @param {string} roomId
 * @param {() => Promise<T>} enter Puts the work in the queue and gives back its result.
 * @returns {Promise<T>}
 */
function takeRoomTurn(roomId, enter) {
  return chained(roomTurns, roomId, () =>
    (roomLocks.get(roomId) ?? Promise.resolve()).then(() => enter()),
  );
}

module.exports = {
  conversationScopeKey,
  clearConversationRoom,
  withRoomLock,
  takeRoomTurn,
  ROOM_MEMORY_TABLES,
};
