"use strict";

const { expect } = require("chai");
const sinon = require("sinon");

const {
  conversationScopeKey,
  clearConversationRoom,
  withRoomLock,
  ROOM_MEMORY_TABLES,
} = require("../src/elizaos/conversationRoom");

// The agent framework keeps a conversation's messages in a room of its database, and that
// database sits outside the enclave. The room is named from this key, so the key must differ for
// every deployment, conversation and owner, and the room is emptied around every run.

const AGENT = "0x1111111111111111111111111111111111111111";
const OTHER_AGENT = "0x2222222222222222222222222222222222222222";
const OWNER = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
const OTHER_OWNER = "0x3333333333333333333333333333333333333333";

const base = { chainId: 84532n, agentAddress: AGENT, conversationId: "7", owner: OWNER };

describe("conversationScopeKey", () => {
  it("is the same for the same deployment, conversation and owner", () => {
    expect(conversationScopeKey(base)).to.equal(conversationScopeKey({ ...base }));
  });

  it("does not depend on the letter case of an address", () => {
    expect(
      conversationScopeKey({
        ...base,
        agentAddress: AGENT.toUpperCase().replace("0X", "0x"),
        owner: OWNER.toLowerCase(),
      }),
    ).to.equal(conversationScopeKey(base));
  });

  it("reads a chain id or a conversation id given as a number, a bigint or a string alike", () => {
    expect(conversationScopeKey({ ...base, chainId: 84532, conversationId: 7n })).to.equal(
      conversationScopeKey({ ...base, chainId: "84532", conversationId: "7" }),
    );
  });

  it("differs for two owners of the same conversation number", () => {
    expect(conversationScopeKey({ ...base, owner: OTHER_OWNER })).to.not.equal(
      conversationScopeKey(base),
    );
  });

  it("differs for another agent contract", () => {
    expect(conversationScopeKey({ ...base, agentAddress: OTHER_AGENT })).to.not.equal(
      conversationScopeKey(base),
    );
  });

  it("differs for another chain", () => {
    expect(conversationScopeKey({ ...base, chainId: 8453n })).to.not.equal(
      conversationScopeKey(base),
    );
  });

  it("differs for another conversation", () => {
    expect(conversationScopeKey({ ...base, conversationId: "8" })).to.not.equal(
      conversationScopeKey(base),
    );
  });

  it("is not the bare conversation number", () => {
    expect(conversationScopeKey(base)).to.not.equal("7");
  });

  for (const [field, values] of [
    ["chainId", [undefined, null, "", 0, -1, 1.5, "84532x", "0x14a34"]],
    ["agentAddress", [undefined, null, "", "0xMockedContractAddress", AGENT.slice(0, 41)]],
    ["conversationId", [undefined, null, "", -1, 1.5, "7a", "room-1"]],
    ["owner", [undefined, null, "", "0xUser", "entity-1", OWNER.slice(2)]],
  ]) {
    it(`refuses a missing or malformed ${field}, naming the field and not the value`, () => {
      for (const value of values) {
        let error;
        try {
          conversationScopeKey({ ...base, [field]: value });
        } catch (caught) {
          error = caught;
        }
        expect(error, `${field} = ${String(value)}`).to.be.instanceOf(Error);
        expect(error.message).to.include(field);
        if (typeof value === "string" && value.length > 2) {
          expect(error.message).to.not.include(value);
        }
      }
    });
  }
});

/** A runtime with the deletion methods the framework offers, recording what it was asked. */
function fakeRuntime({ agentLogs = 0, failing = {} } = {}) {
  const calls = [];
  let logs = Array.from({ length: agentLogs }, (_, i) => ({ id: `log-${i}`, roomId: "agent-1" }));
  const step = (name, fn) =>
    sinon.spy(async (...args) => {
      calls.push([name, ...args]);
      if (failing[name]) throw failing[name];
      return fn ? fn(...args) : undefined;
    });

  const runtime = {
    agentId: "agent-1",
    deleteAllMemories: step("deleteAllMemories"),
    deleteRoom: step("deleteRoom"),
    deleteCache: step("deleteCache"),
    getLogs: step("getLogs", ({ roomId, count }) =>
      logs.filter((log) => log.roomId === roomId).slice(0, count),
    ),
    deleteLog: step("deleteLog", (id) => {
      logs = logs.filter((log) => log.id !== id);
    }),
  };

  return { runtime, calls, logsLeft: () => logs.length };
}

describe("clearConversationRoom", () => {
  let consoleError;

  beforeEach(() => {
    consoleError = sinon.stub(console, "error");
  });

  afterEach(() => {
    sinon.restore();
  });

  it("empties every memory table the framework writes for a room, then deletes the room", async () => {
    const { runtime, calls } = fakeRuntime();

    const failed = await clearConversationRoom(runtime, "room-x", "before the run");

    expect(failed).to.deep.equal([]);
    expect(ROOM_MEMORY_TABLES).to.include.members(["messages", "facts"]);
    for (const table of ROOM_MEMORY_TABLES) {
      expect(calls).to.deep.include(["deleteAllMemories", "room-x", table]);
    }
    expect(calls).to.deep.include(["deleteRoom", "room-x"]);
    const lastMemoryClear = calls.map(([name]) => name).lastIndexOf("deleteAllMemories");
    const roomDelete = calls.findIndex(([name]) => name === "deleteRoom");
    expect(roomDelete, "the room goes after its memories").to.be.greaterThan(lastMemoryClear);
    expect(consoleError.called).to.equal(false);
  });

  it("removes the reflection marker the framework keeps for the room", async () => {
    const { runtime, calls } = fakeRuntime();

    await clearConversationRoom(runtime, "room-x", "after the run");

    expect(calls).to.deep.include(["deleteCache", "room-x-reflection-last-processed"]);
  });

  it("removes the model-call records kept under the agent's own room", async () => {
    // A model call made while no run is marked as current is recorded under the agent's own room,
    // with the whole prompt in it.
    const { runtime, logsLeft } = fakeRuntime({ agentLogs: 250 });

    const failed = await clearConversationRoom(runtime, "room-x", "after the run");

    expect(failed).to.deep.equal([]);
    expect(logsLeft()).to.equal(0);
  });

  it("goes on with the other parts when one fails, and says which part failed", async () => {
    const boom = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
    const { runtime, calls } = fakeRuntime({ failing: { deleteAllMemories: boom } });

    const failed = await clearConversationRoom(runtime, "room-x", "after the run");

    expect(failed).to.include("messages");
    expect(
      calls.some(([name]) => name === "deleteRoom"),
      "the room is still deleted",
    ).to.equal(true);
    expect(consoleError.called).to.equal(true);
    const line = consoleError
      .getCalls()
      .map((call) => call.args.join(" "))
      .join("\n");
    expect(line).to.match(/could not clear/i);
    expect(line).to.include("after the run");
    expect(line).to.include("messages");
    expect(line).to.include("ECONNREFUSED");
  });

  it("never throws, even for a runtime without the deletion methods", async () => {
    const failed = await clearConversationRoom({ agentId: "agent-1" }, "room-x", "before the run");

    expect(failed).to.include("room");
    expect(consoleError.called).to.equal(true);
  });
});

describe("withRoomLock", () => {
  const deferred = () => {
    let resolve;
    const promise = new Promise((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };

  it("runs the tasks of one room one after the other", async () => {
    const order = [];
    const gate = deferred();

    const first = withRoomLock("room-a", async () => {
      order.push("first started");
      await gate.promise;
      order.push("first ended");
    });
    const second = withRoomLock("room-a", async () => {
      order.push("second started");
    });

    await new Promise((r) => setImmediate(r));
    expect(order).to.deep.equal(["first started"]);
    gate.resolve();
    await Promise.all([first, second]);
    expect(order).to.deep.equal(["first started", "first ended", "second started"]);
  });

  it("does not hold up another room", async () => {
    const gate = deferred();
    let otherRan = false;

    const first = withRoomLock("room-a", () => gate.promise);
    await withRoomLock("room-b", async () => {
      otherRan = true;
    });

    expect(otherRan).to.equal(true);
    gate.resolve();
    await first;
  });

  it("lets the next task run after one that throws, and passes the throw on", async () => {
    const failing = withRoomLock("room-a", async () => {
      throw new Error("boom");
    });
    const next = withRoomLock("room-a", async () => "ran");

    let thrown;
    try {
      await failing;
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.message).to.equal("boom");
    expect(await next).to.equal("ran");
  });

  it("gives back what the task returned", async () => {
    expect(await withRoomLock("room-c", async () => 42)).to.equal(42);
  });
});
