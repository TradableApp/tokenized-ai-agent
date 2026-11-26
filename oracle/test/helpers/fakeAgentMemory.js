"use strict";

/**
 * The parts of the agent runtime the oracle confines and sweeps before it lets the agent answer
 * (src/elizaos/agentMemory.js), for a test's stand-in runtime: a database adapter whose log
 * stores nothing yet, no evaluators, a message service whose processing can be followed, and a
 * database that takes the sweep's statements and removes nothing. Spread into the stand-in.
 *
 * @param {{ statements?: string[] }} [seen] Collects the sweep's statements when given.
 */
function agentMemorySurface(seen = {}) {
  const statements = seen.statements ?? [];
  return {
    evaluators: [],
    adapter: {
      log: async () => {},
      deleteEntity: async () => {},
    },
    messageService: {
      processMessage: async () => ({}),
    },
    queueEmbeddingGeneration: async () => {},
    getRoomsForParticipants: async () => [],
    db: {
      transaction: async (fn) =>
        fn({
          execute: async (statement) => {
            statements.push(statement);
            return { rowCount: 0 };
          },
        }),
    },
  };
}

module.exports = { agentMemorySurface };
