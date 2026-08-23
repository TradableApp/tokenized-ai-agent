const { expect } = require("chai");
const { ethers } = require("ethers");
const fs = require("fs");

// The heartbeat's failed-jobs probe (CU-86d438hwt).
//
// THE BUG THIS PINS, seen across all three beats of the 2026-08-22 Base-testnet run:
// `failedJobsCount` was NULL every time, on an oracle that was working perfectly.
//
// `failed-jobs.json` is only written once a job has actually failed, so on a healthy oracle it
// simply does not exist. The heartbeat wired the probe as a bare
// `JSON.parse(await fs.readFile(...))`, ENOENT threw, `safe()` degraded it to null — and the
// panel reported "unknown" forever for the one figure that should read a confident 0.
//
// "No failures" and "cannot tell" must not look the same; that confusion is the whole reason
// oracleVitals degrades per-probe instead of per-snapshot. The oracle's own retry loop already
// treats a missing or corrupt file as `[]` — the heartbeat just wasn't using the same reader.

const noop = () => {};

describe("heartbeat failed-jobs probe", () => {
  // aiAgentOracle builds a signer at module load, so the placeholder key in .env.oracle.example
  // is not enough. Scoped to THIS suite deliberately: as a root-level hook it fires before every
  // suite in the run, and another suite's cleanup then deletes PRIVATE_KEY before these tests get
  // to it.
  let oracle;
  let saved;

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

  it("reports an EMPTY LIST when failed-jobs.json does not exist yet", async () => {
    // The healthy-oracle case, and the one that was broken in production.
    const { readFailedJobsList } = oracle;
    expect(readFailedJobsList, "aiAgentOracle must export a tolerant reader").to.be.a("function");

    const jobs = await readFailedJobsList(async () => {
      throw enoent();
    });
    expect(jobs).to.deep.equal([]);
  });

  it("reports an EMPTY LIST when the file is corrupt, rather than throwing", async () => {
    const { readFailedJobsList } = oracle;
    const jobs = await readFailedJobsList(async () => "{not json");
    expect(jobs).to.deep.equal([]);
  });

  it("treats a non-array payload as empty, matching the retry loop's own handling", async () => {
    const { readFailedJobsList } = oracle;
    expect(await readFailedJobsList(async () => "{}")).to.deep.equal([]);
  });

  it("returns the real jobs when there ARE failures", async () => {
    const { readFailedJobsList } = oracle;
    const jobs = await readFailedJobsList(async () => JSON.stringify([{ id: 1 }, { id: 2 }]));
    expect(jobs).to.have.length(2);
  });

  it("wires the heartbeat through that reader, not a raw readFile", () => {
    // A correct helper that the wiring bypasses is still a null in Slack, and `start()` cannot be
    // driven from a unit test (it needs a live chain), so assert the wiring structurally — the
    // same approach cursorPersistence.test.js takes for the cursor writes.
    const source = fs.readFileSync(require.resolve("../src/aiAgentOracle"), "utf8");

    expect(source, "heartbeat must be handed the tolerant reader").to.match(
      /readFailedJobs:\s*readFailedJobsList\b/,
    );
    expect(
      source,
      "no raw failed-jobs read may remain — it throws ENOENT on a healthy oracle",
    ).to.not.match(/readFailedJobs:\s*async[^\n]*fs\.readFile\(\s*FAILED_JOBS_FILE_PATH/);
  });
});
