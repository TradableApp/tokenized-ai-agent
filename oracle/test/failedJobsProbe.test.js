const { expect } = require("chai");
const sinon = require("sinon");
const { ethers } = require("ethers");
const fs = require("fs");

const { createTempStateStore, txHash, failJobAttempts } = require("./helpers/tempStateStore");

// The heartbeat's failed-jobs probe (CU-86d438hwt).
//
// THE BUG THIS PINS, seen across all three beats of the 2026-08-22 Base-testnet run:
// `failedJobsCount` was NULL every time, on an oracle that was working perfectly.
//
// The queue was then a file, `failed-jobs.json`, written only once a job had actually failed — so
// on a healthy oracle it did not exist. The heartbeat read it with a bare `fs.readFile`, ENOENT
// threw, `safe()` degraded it to null, and the panel reported "unknown" forever for the one
// figure that should read a confident 0.
//
// The queue now lives in the state store, and the probe is `countFailedJobs()`: waiting for a
// retry plus given up on. The rule is unchanged. "No failures" must be the number 0, and "cannot
// tell" must THROW so the vitals collector reports null — the two must never look the same; that
// confusion is the whole reason oracleVitals degrades per-probe instead of per-snapshot.

describe("heartbeat failed-jobs probe", () => {
  // aiAgentOracle builds a signer at module load, so the placeholder key in .env.oracle.example
  // is not enough. Scoped to THIS suite deliberately: as a root-level hook it fires before every
  // suite in the run, and another suite's cleanup then deletes PRIVATE_KEY before these tests get
  // to it.
  let oracle;
  let saved;
  let temp;

  before(() => {
    const w = ethers.Wallet.createRandom();
    saved = { pk: process.env.PRIVATE_KEY, addr: process.env.AI_AGENT_CONTRACT_ADDRESS };
    process.env.PRIVATE_KEY = w.privateKey;
    process.env.AI_AGENT_CONTRACT_ADDRESS = w.address;
    delete require.cache[require.resolve("../src/aiAgentOracle")];
    oracle = require("../src/aiAgentOracle");
  });

  after(() => {
    if (saved.pk === undefined) delete process.env.PRIVATE_KEY;
    else process.env.PRIVATE_KEY = saved.pk;
    if (saved.addr === undefined) delete process.env.AI_AGENT_CONTRACT_ADDRESS;
    else process.env.AI_AGENT_CONTRACT_ADDRESS = saved.addr;
    delete require.cache[require.resolve("../src/aiAgentOracle")];
  });

  beforeEach(() => {
    temp = createTempStateStore();
    oracle.initForTest({ stateStore: temp.store });
  });

  afterEach(() => {
    temp.cleanup();
  });

  const enqueue = (seed) =>
    temp.store.enqueueFailedJob({
      transactionHash: txHash(seed),
      logIndex: 0,
      eventName: "PromptSubmitted",
      blockNumber: 100,
      delayMs: 0,
    });

  it("reports the NUMBER 0 on a fresh store, not null", async () => {
    // The healthy-oracle case, and the one that was broken in production.
    const { countFailedJobs } = oracle;
    expect(countFailedJobs, "aiAgentOracle must export the probe").to.be.a("function");

    const count = await countFailedJobs();

    expect(count).to.equal(0);
  });

  it("counts pending and exhausted jobs together when there ARE failures", async () => {
    // Two waiting for a retry, one given up on: all three need someone's attention.
    await enqueue("pending-1");
    await enqueue("pending-2");
    await enqueue("exhausted");
    const [first] = await temp.store.claimDueJobs({ limit: 1, leaseMs: 0 });
    await temp.store.exhaustJob(first.id, { error: new Error("out of attempts") });

    const count = await oracle.countFailedJobs();

    expect(await temp.store.countFailedJobs()).to.deep.equal({ pending: 2, exhausted: 1 });
    expect(count).to.equal(3);
  });

  it("is unaffected by how many attempts a pending job has used", async () => {
    await enqueue("retried");
    await failJobAttempts(temp.store, 3);

    expect(await oracle.countFailedJobs()).to.equal(1);
  });

  it("THROWS when the store cannot be read, so the heartbeat reports unknown rather than 0", async () => {
    const unreadable = {
      countFailedJobs: sinon.stub().rejects(new Error("connection refused")),
    };

    let thrown;
    await oracle.countFailedJobs(unreadable).catch((error) => (thrown = error));

    expect(thrown, "a failed read must never come back as a confident 0").to.be.instanceOf(Error);
    expect(thrown.message).to.equal("connection refused");
  });

  it("wires the heartbeat through countFailedJobs, not a raw read", () => {
    // A correct probe that the wiring bypasses is still a null in Slack, and `start()` cannot be
    // driven from a unit test (it needs a live chain), so assert the wiring structurally — the
    // same approach cursorPersistence.test.js takes for the cursor writes.
    const source = fs.readFileSync(require.resolve("../src/aiAgentOracle"), "utf8");
    const start = source.indexOf("async function start(");
    const body = source.slice(start, source.indexOf("\n}", start));
    const callStart = body.indexOf("startOracleHeartbeat({");
    expect(callStart, "start() must start the heartbeat").to.be.greaterThan(-1);
    const call = body.slice(callStart, body.indexOf("});", callStart));

    expect(call, "heartbeat must be handed the store-backed probe").to.match(
      /\bcountFailedJobs(\s*:\s*countFailedJobs)?\s*,/,
    );
    expect(
      source,
      "no raw failed-jobs read may remain — it threw ENOENT on a healthy oracle",
    ).to.not.match(/readFailedJobs|fs\.readFile\(\s*FAILED_JOBS_FILE_PATH/);
  });
});
