"use strict";

/**
 * What the agent framework may keep in its database, which is outside the enclave.
 *
 * The oracle rebuilds a conversation's history from storage for every prompt and empties the
 * conversation's room around the run (see conversationRoom.js). Whatever the framework derives
 * for later use therefore has no reader, and is only cost and something more to keep safe. So,
 * before the agent answers anything:
 *
 * - `confineRuntimeToTheRun` stops the runtime writing what only a later run could read: it runs
 *   no evaluator (the reflection step's facts, relationships and marker, and the log of its whole
 *   state), stores no log record (each model call's whole prompt, filed under whichever room's
 *   run started last), queues no embedding (written after the run, for memories the clear has
 *   already removed), and lists no rooms across participants (its one use, the recent messages
 *   provider, would otherwise read the other rooms the agent takes part in, which is all of them);
 * - `sweepAgentMemory` removes every conversation an earlier process left: every room but the
 *   agent's own with what hangs off it, every entity, world and relationship but the agent's own,
 *   the conversation memories and the log records left under the agent's own room, and the
 *   reflection markers. It touches the framework's tables only, never the oracle's own state.
 *
 * `createAgentMemoryGate` runs both once per runtime and refuses the agent until they have
 * succeeded.
 */

const { describeError } = require("../errorDescription");

// Memory tables a run writes under a conversation's room (@elizaos/core and plugin-bootstrap
// 1.7.2, plugin-mcp): the messages, the reflection step's facts, and what the tool plugin keeps of
// a tool's or a resource's output. A memory's table is its `type` in the database.
const ROOM_MEMORY_TABLES = Object.freeze(["messages", "facts", "tools", "resources"]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Each step is given the agent's id as a quoted uuid literal, made in sweepAgentMemory only after
// the id has matched UUID: that match is what makes it safe to write into the statement, so no
// other value may be written into one this way.
// One statement per step, run in one transaction. The agent's own room, world and entity share
// the agent's id and are kept. Rooms go first: a room's memories (and their embeddings), log
// records, participants and components are deleted with it by the schema's foreign keys.
const SWEEP_STEPS = Object.freeze([
  ["rooms", (agent) => `DELETE FROM rooms WHERE agent_id = ${agent} AND id <> ${agent}`],
  [
    "memories",
    (agent) =>
      `DELETE FROM memories WHERE agent_id = ${agent} AND type IN (${ROOM_MEMORY_TABLES.map((t) => `'${t}'`).join(", ")})`,
  ],
  ["logs", (agent) => `DELETE FROM logs WHERE room_id = ${agent}`],
  ["entities", (agent) => `DELETE FROM entities WHERE agent_id = ${agent} AND id <> ${agent}`],
  ["relationships", (agent) => `DELETE FROM relationships WHERE agent_id = ${agent}`],
  ["worlds", (agent) => `DELETE FROM worlds WHERE agent_id = ${agent} AND id <> ${agent}`],
  [
    "reflection markers",
    (agent) =>
      `DELETE FROM cache WHERE agent_id = ${agent} AND key LIKE '%-reflection-last-processed'`,
  ],
]);

const confined = new WeakSet();
// Per runtime, the framework's message processing not yet settled, by room.
const processing = new WeakMap();

/** A promise that settles with `promise` or after `ms`, whichever is first, and never rejects. */
function settledWithin(promise, ms) {
  let timer;
  const waited = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
  return Promise.race([Promise.resolve(promise).then(noop, noop), waited]).finally(() =>
    clearTimeout(timer),
  );
}

function noop() {}

/**
 * Keeps the runtime from writing what only a later run could read, and follows its message
 * processing so a run the framework has given up on can be waited for (`runStillGoing`). Throws
 * when the runtime is not the shape this was written against; the agent is then not used.
 * Idempotent.
 *
 * @param {object} runtime The agent runtime.
 */
function confineRuntimeToTheRun(runtime) {
  if (confined.has(runtime)) return;
  const adapter = runtime?.adapter;
  const service = runtime?.messageService;
  if (!adapter || typeof adapter.log !== "function") {
    throw new Error("The agent runtime has no database adapter to confine");
  }
  if (!service || typeof service.processMessage !== "function") {
    throw new Error("The agent runtime has no message service to follow");
  }
  if (!Array.isArray(runtime.evaluators)) {
    throw new Error("The agent runtime has no list of evaluators");
  }

  // Checked after the write: a list that did not take it would leave the evaluators running.
  const none = [];
  runtime.evaluators = none;
  if (runtime.evaluators !== none) {
    throw new Error("The agent runtime's evaluator list could not be replaced");
  }
  adapter.log = async () => {};
  runtime.queueEmbeddingGeneration = async () => {};
  runtime.getRoomsForParticipants = async () => [];

  const byRoom = new Map();
  processing.set(runtime, byRoom);
  const processMessage = service.processMessage;
  service.processMessage = function followed(processedBy, message, ...rest) {
    const run = processMessage.call(this, processedBy, message, ...rest);
    const roomId = message?.roomId;
    const runs = byRoom.get(roomId) ?? new Set();
    byRoom.set(roomId, runs);
    runs.add(run);
    // Attached before anything else waits on the run, so it is forgotten as soon as it settles.
    Promise.resolve(run)
      .then(noop, noop)
      .then(() => {
        runs.delete(run);
        if (runs.size === 0 && byRoom.get(roomId) === runs) byRoom.delete(roomId);
      });
    return run;
  };

  confined.add(runtime);
}

/**
 * The framework's processing of a message in `roomId` that has not settled yet, or null. A run
 * the framework has timed out goes on, and this is how its end is waited for.
 *
 * @returns {Promise<void>|null}
 */
function runStillGoing(runtime, roomId) {
  const runs = processing.get(runtime)?.get(roomId);
  if (!runs || runs.size === 0) return null;
  return Promise.all([...runs].map((run) => Promise.resolve(run).then(noop, noop))).then(noop);
}

/** Rows removed by a statement, as node-postgres and PGlite each report it. */
function removedRows(result) {
  return Number(result?.rowCount ?? result?.affectedRows ?? 0);
}

/**
 * Removes from the agent database every conversation an earlier process left (see the module
 * comment), in one transaction. Raw statements, because the adapter has no way to list every room
 * or entity, nor to delete relationships or cache rows by pattern; each names only the
 * framework's own tables and only this agent's rows. Throws when it cannot.
 *
 * @param {object} runtime The agent runtime.
 * @returns {Promise<Record<string, number>>} The rows removed, by step.
 */
async function sweepAgentMemory(runtime) {
  const agentId = runtime?.agentId;
  if (typeof agentId !== "string" || !UUID.test(agentId)) {
    throw new Error("The agent's id is not a well-formed id");
  }
  const db = runtime.db;
  if (!db || typeof db.transaction !== "function") {
    throw new Error("The agent runtime has no database to sweep");
  }

  const agent = `'${agentId.toLowerCase()}'::uuid`;
  const removed = {};
  await db.transaction(async (tx) => {
    for (const [step, statement] of SWEEP_STEPS) {
      removed[step] = removedRows(await tx.execute(statement(agent)));
    }
  });
  return removed;
}

/**
 * The agent is used only once its runtime is confined and the database has been swept, once per
 * runtime. `ensure(runtime)` resolves when that is done and throws otherwise, so the caller can
 * answer another way; the next call tries again. Each failure is printed with `describeError`;
 * the first in the process is also given to `report`.
 *
 * @param {{ report?: (error: Error) => void }} [options]
 */
function createAgentMemoryGate({ report = noop } = {}) {
  const ready = new WeakSet();
  const inFlight = new WeakMap();
  let reported = false;

  async function prepare(runtime) {
    confineRuntimeToTheRun(runtime);
    const removed = await sweepAgentMemory(runtime);
    const counts = Object.entries(removed)
      .map(([step, count]) => `${count} ${step}`)
      .join(", ");
    console.log(`[ElizaOS] Removed what earlier runs left in the agent database: ${counts}.`);
  }

  return async function ensure(runtime) {
    if (ready.has(runtime)) return;
    let attempt = inFlight.get(runtime);
    if (!attempt) {
      attempt = prepare(runtime).then(
        () => {
          ready.add(runtime);
        },
        (error) => {
          console.error(
            `[ElizaOS] Could not empty the agent database of earlier conversations; the agent is not used until it is: ${describeError(error)}`,
          );
          if (!reported) {
            reported = true;
            try {
              report(error);
            } catch {
              // A report that fails costs nothing more.
            }
          }
          throw new Error("The agent database has not been emptied of earlier conversations");
        },
      );
      inFlight.set(runtime, attempt);
      attempt.then(noop, noop).then(() => inFlight.delete(runtime));
    }
    await attempt;
  };
}

module.exports = {
  ROOM_MEMORY_TABLES,
  confineRuntimeToTheRun,
  runStillGoing,
  settledWithin,
  sweepAgentMemory,
  createAgentMemoryGate,
};
