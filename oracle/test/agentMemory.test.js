"use strict";

const { expect } = require("chai");
const sinon = require("sinon");
const { AgentRuntime, DefaultMessageService, EventType, ModelType } = require("@elizaos/core");

const {
  confineRuntimeToTheRun,
  runStillGoing,
  sweepAgentMemory,
  createAgentMemoryGate,
} = require("../src/elizaos/agentMemory");
const { agentMemorySurface } = require("./helpers/fakeAgentMemory");

// The agent framework's database is outside the enclave, and the oracle empties a conversation's
// room around every run. What the framework would derive from a run for a later one has no reader,
// so the runtime is kept from writing it, and what earlier processes left is removed before the
// agent answers anything.

const AGENT_ID = "00000000-0000-4000-8000-0000000000a9";

/** The framework's own runtime, on a database adapter that records what it is asked. */
function frameworkRuntime() {
  const adapter = {
    log: sinon.spy(async () => {}),
    getRoomsForParticipants: sinon.spy(async () => ["another-room"]),
    isReady: async () => true,
  };
  const runtime = new AgentRuntime({
    agentId: AGENT_ID,
    character: { name: "SenseAI", bio: "An agent." },
    adapter,
  });
  runtime.messageService = new DefaultMessageService();
  return { runtime, adapter, adapterLog: adapter.log };
}

describe("confineRuntimeToTheRun", () => {
  afterEach(() => {
    sinon.restore();
  });

  it("runs no evaluator, so nothing is drawn from a run for later", async () => {
    const { runtime } = frameworkRuntime();
    const handler = sinon.spy(async () => {});
    runtime.registerEvaluator({
      name: "REFLECTION",
      description: "draws facts",
      similes: [],
      examples: [],
      alwaysRun: true,
      validate: async () => true,
      handler,
    });

    confineRuntimeToTheRun(runtime);
    const ran = await runtime.evaluate({ roomId: "room", content: { text: "hi" } }, {}, true);

    expect(ran).to.deep.equal([]);
    expect(handler.called).to.equal(false);
  });

  it("stores no record of a model call, whose prompt is the whole conversation", async () => {
    const { runtime, adapterLog } = frameworkRuntime();
    runtime.registerModel(ModelType.TEXT_SMALL, async () => "a reply", "test");

    confineRuntimeToTheRun(runtime);
    runtime.startRun("some-room");
    await runtime.useModel(ModelType.TEXT_SMALL, { prompt: "the whole conversation" });
    await runtime.log({ entityId: AGENT_ID, roomId: "some-room", type: "run_event", body: {} });

    expect(adapterLog.called).to.equal(false);
  });

  it("queues no embedding, which would be written after the room is emptied", async () => {
    const { runtime } = frameworkRuntime();
    const requested = sinon.spy(async () => {});
    runtime.registerEvent(EventType.EMBEDDING_GENERATION_REQUESTED, requested);

    confineRuntimeToTheRun(runtime);
    await runtime.queueEmbeddingGeneration({ id: "m", content: { text: "a fact" } }, "low");

    expect(requested.called).to.equal(false);
  });

  it("lists no rooms across participants, so no run reads another room", async () => {
    // The recent messages provider reads every room in which the owner's entity or the agent
    // takes part, and the agent takes part in every room.
    const { runtime, adapter } = frameworkRuntime();

    confineRuntimeToTheRun(runtime);

    expect(await runtime.getRoomsForParticipants(["owner", AGENT_ID])).to.deep.equal([]);
    expect(adapter.getRoomsForParticipants.called).to.equal(false);
  });

  it("refuses a runtime of another shape", () => {
    expect(() => confineRuntimeToTheRun({ evaluators: [] })).to.throw(/database adapter/);
    expect(() =>
      confineRuntimeToTheRun({ evaluators: [], adapter: { log() {} } }),
    ).to.throw(/message service/);
  });

  it("can be asked twice", () => {
    const { runtime } = frameworkRuntime();
    confineRuntimeToTheRun(runtime);
    const followed = runtime.messageService.processMessage;

    confineRuntimeToTheRun(runtime);

    expect(runtime.messageService.processMessage).to.equal(followed);
  });
});

describe("runStillGoing", () => {
  it("follows the framework's processing of a message until it settles", async () => {
    const { runtime } = frameworkRuntime();
    let finish;
    runtime.messageService.processMessage = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    confineRuntimeToTheRun(runtime);

    const processing = runtime.messageService.processMessage(runtime, { roomId: "room-1" });

    expect(runStillGoing(runtime, "room-1")).to.be.an.instanceOf(Promise);
    expect(runStillGoing(runtime, "room-2")).to.equal(null);
    finish();
    await processing;
    await new Promise((resolve) => setImmediate(resolve));
    expect(runStillGoing(runtime, "room-1")).to.equal(null);
  });

  it("follows a processing that rejects, and never rejects itself", async () => {
    const { runtime } = frameworkRuntime();
    let fail;
    runtime.messageService.processMessage = () =>
      new Promise((_, reject) => {
        fail = reject;
      });
    confineRuntimeToTheRun(runtime);

    const processing = runtime.messageService.processMessage(runtime, { roomId: "room-1" });
    const still = runStillGoing(runtime, "room-1");
    fail(new Error("late"));

    await processing.catch(() => {});
    await still;
    await new Promise((resolve) => setImmediate(resolve));
    expect(runStillGoing(runtime, "room-1")).to.equal(null);
  });
});

describe("sweepAgentMemory", () => {
  it("runs in one transaction on the framework's tables only, for this agent only", async () => {
    const seen = { statements: [] };
    const runtime = { ...agentMemorySurface(seen), agentId: AGENT_ID };
    const transaction = sinon.spy(runtime.db, "transaction");

    await sweepAgentMemory(runtime);

    expect(transaction.calledOnce).to.equal(true);
    expect(seen.statements.length).to.be.greaterThan(0);
    for (const statement of seen.statements) {
      expect(statement).to.match(/^DELETE FROM (rooms|memories|logs|entities|relationships|worlds|cache) /);
      expect(statement).to.include(`'${AGENT_ID}'::uuid`);
      expect(statement).to.not.match(/oracle_state|oracle_cursors|oracle_failed_jobs/);
    }
  });

  it("refuses an agent id that is not an id", async () => {
    const runtime = { ...agentMemorySurface(), agentId: "x' OR '1'='1" };

    let thrown;
    await sweepAgentMemory(runtime).catch((error) => {
      thrown = error;
    });

    expect(thrown?.message).to.match(/well-formed/);
  });
});

describe("createAgentMemoryGate", () => {
  let consoleError;

  beforeEach(() => {
    consoleError = sinon.stub(console, "error");
    sinon.stub(console, "log");
  });

  afterEach(() => {
    sinon.restore();
  });

  const refused = () => Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });

  it("refuses until the sweep has succeeded, then lets every run through without sweeping again", async () => {
    const report = sinon.spy();
    const ensure = createAgentMemoryGate({ report });
    const runtime = { ...agentMemorySurface(), agentId: AGENT_ID };
    const { transaction } = runtime.db;
    runtime.db.transaction = sinon.stub().onFirstCall().rejects(refused()).callsFake(transaction);

    let thrown;
    await ensure(runtime).catch((error) => {
      thrown = error;
    });
    expect(thrown?.message).to.match(/not been emptied/);

    await ensure(runtime);
    await ensure(runtime);
    expect(runtime.db.transaction.callCount).to.equal(2);
  });

  it("prints each failure described, and reports the first in the process only", async () => {
    const report = sinon.spy();
    const ensure = createAgentMemoryGate({ report });
    const runtime = { ...agentMemorySurface(), agentId: AGENT_ID };
    runtime.db.transaction = sinon.stub().rejects(refused());

    for (let i = 0; i < 3; i += 1) await ensure(runtime).catch(() => {});

    expect(report.callCount).to.equal(1);
    expect(consoleError.callCount).to.equal(3);
    expect(consoleError.firstCall.args.join(" ")).to.include("ECONNREFUSED");
  });

  it("makes one attempt for runs that ask at the same time", async () => {
    const ensure = createAgentMemoryGate();
    const runtime = { ...agentMemorySurface(), agentId: AGENT_ID };
    const transaction = sinon.spy(runtime.db, "transaction");

    await Promise.all([ensure(runtime), ensure(runtime), ensure(runtime)]);

    expect(transaction.calledOnce).to.equal(true);
  });

  it("refuses a runtime it cannot confine, without a sweep", async () => {
    const ensure = createAgentMemoryGate();
    const runtime = { ...agentMemorySurface(), agentId: AGENT_ID, messageService: null };
    const transaction = sinon.spy(runtime.db, "transaction");

    let thrown;
    await ensure(runtime).catch((error) => {
      thrown = error;
    });

    expect(thrown?.message).to.match(/not been emptied/);
    expect(transaction.called).to.equal(false);
  });
});
