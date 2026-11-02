const { expect } = require("chai");

// The answer poller discovers AnswerMessageAdded with eth_getLogs. Providers cap the block range
// per call — Alchemy's free tier at 10 blocks — and the 2026-11-02 run day lost all five smoke
// verdicts to that: every poll asked for [submitBlock, head] in one request, the node refused
// it, the window never advanced, and the oracle's five on-chain answers went unseen for 300s.
// The poller must therefore walk the range in capped, contiguous chunks, keep its place across
// a failed call, and say what the node actually answered.

const { waitForAnswer, rpcErrorMessage } = require("../scripts/smoke/answerWait.js");

const FROM = 1000;
const CONV = 21;
const MSG = 99;

/** A fake agent whose queryFilter is scripted per call: an array of events, or an Error to throw. */
function fakeChain({ head, responses }) {
  const calls = [];
  let i = 0;
  const agent = {
    filters: { AnswerMessageAdded: (c, m) => ({ c, m }) },
    async queryFilter(filter, from, to) {
      calls.push({ from, to, filter });
      const r = responses[Math.min(i++, responses.length - 1)];
      if (r instanceof Error) throw r;
      return r;
    },
    async isJobFinalized() {
      return false;
    },
  };
  const provider = { getBlockNumber: async () => head() };
  return { agent, provider, calls };
}

/** Deterministic clock: every sleep advances it by the requested ms. */
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => void (t += ms) };
}

const cfg = { timeoutMs: 300_000, pollMs: 6_000, logsBlockRange: 10 };
const evt = (block) => ({ blockNumber: block, args: { messageCID: `cid-${block}` } });

describe("smoke: waitForAnswer — chunked eth_getLogs", () => {
  it("never asks for more than logsBlockRange blocks in one call, and the chunks are contiguous", async () => {
    // head is 35 blocks past the submit block; the answer is in the last chunk
    const { agent, provider, calls } = fakeChain({
      head: () => FROM + 34,
      responses: [[], [], [], [evt(FROM + 33)]],
    });
    const { now, sleep } = fakeClock();
    const log = [];
    const evts = await waitForAnswer({
      agent, provider, conversationId: CONV, answerMessageId: MSG, fromBlock: FROM, cfg,
      log: (l) => log.push(l), now, sleep,
    });
    expect(evts.map((e) => e.blockNumber)).to.deep.equal([FROM + 33]);
    expect(calls.map((c) => [c.from, c.to])).to.deep.equal([
      [FROM, FROM + 9], [FROM + 10, FROM + 19], [FROM + 20, FROM + 29], [FROM + 30, FROM + 34],
    ]);
    for (const c of calls) expect(c.to - c.from + 1, `window ${c.from}-${c.to}`).to.be.at.most(10);
    expect(calls[0].filter).to.deep.equal({ c: CONV, m: MSG });
  });

  it("resumes at the chunk that failed, not at the original fromBlock", async () => {
    const refused = Object.assign(new Error("could not coalesce error"), {
      shortMessage: "could not coalesce error",
      error: { code: -32600, message: "Under the Free tier, eth_getLogs is limited to a 10 block range" },
    });
    const { agent, provider, calls } = fakeChain({
      head: () => FROM + 25,
      responses: [[], refused, [evt(FROM + 12)]],
    });
    const { now, sleep } = fakeClock();
    const log = [];
    const evts = await waitForAnswer({
      agent, provider, conversationId: CONV, answerMessageId: MSG, fromBlock: FROM, cfg,
      log: (l) => log.push(l), now, sleep,
    });
    expect(evts).to.have.length(1);
    // poll 1: chunk 1 ok, chunk 2 refused → poll 2 starts again at chunk 2, never re-reads chunk 1
    expect(calls.map((c) => [c.from, c.to])).to.deep.equal([
      [FROM, FROM + 9], [FROM + 10, FROM + 19], [FROM + 10, FROM + 19],
    ]);
    // the node's own message is what gets logged, with the window it refused
    expect(log.join("\n")).to.match(/Under the Free tier/);
    expect(log.join("\n")).to.match(/blocks 1010-1019/);
    expect(log.join("\n")).to.not.match(/^.*could not coalesce error.*$/m);
  });

  it("gives up with a TIMEOUT that names the last RPC error", async () => {
    const refused = Object.assign(new Error("could not coalesce error"), {
      shortMessage: "could not coalesce error",
      info: { error: { code: -32005, message: "rate limited: 330 CU/s exceeded" } },
    });
    const { agent, provider } = fakeChain({ head: () => FROM + 3, responses: [refused] });
    const { now, sleep } = fakeClock();
    let err;
    try {
      await waitForAnswer({
        agent, provider, conversationId: CONV, answerMessageId: 7, fromBlock: FROM, cfg,
        log: () => {}, now, sleep,
      });
    } catch (e) {
      err = e;
    }
    expect(err).to.be.an("error");
    expect(err.message).to.match(/^TIMEOUT: no AnswerMessageAdded for answerMessageId=7 within 300s/);
    expect(err.message).to.match(/last RPC error: .*rate limited: 330 CU\/s exceeded/);
  });

  it("returns every matching event in the window where the answer appeared (burst duplicates stay visible)", async () => {
    const { agent, provider } = fakeChain({
      head: () => FROM + 2,
      responses: [[evt(FROM + 1), evt(FROM + 2)]],
    });
    const { now, sleep } = fakeClock();
    const evts = await waitForAnswer({
      agent, provider, conversationId: CONV, answerMessageId: MSG, fromBlock: FROM, cfg,
      log: () => {}, now, sleep,
    });
    expect(evts).to.have.length(2);
  });

  it("waits for the chain to reach fromBlock before asking for logs", async () => {
    let head = FROM - 2;
    const { agent, provider, calls } = fakeChain({ head: () => head, responses: [[evt(FROM)]] });
    const { now, sleep } = fakeClock();
    const evts = await waitForAnswer({
      agent, provider, conversationId: CONV, answerMessageId: MSG, fromBlock: FROM, cfg,
      log: () => {}, now, sleep: async (ms) => { head = FROM; await sleep(ms); },
    });
    expect(evts).to.have.length(1);
    expect(calls.map((c) => [c.from, c.to])).to.deep.equal([[FROM, FROM]]);
  });
});

describe("smoke: rpcErrorMessage", () => {
  it("prefers the node's JSON-RPC error over ethers' wrapper text", () => {
    const e = Object.assign(new Error("could not coalesce error (payload=…)"), {
      shortMessage: "could not coalesce error",
      error: { code: -32600, message: "Under the Free tier, eth_getLogs is limited to a 10 block range" },
    });
    expect(rpcErrorMessage(e)).to.equal(
      "Under the Free tier, eth_getLogs is limited to a 10 block range (code -32600)",
    );
  });

  it("falls back through info.error, shortMessage and message", () => {
    expect(rpcErrorMessage({ info: { error: { message: "nope" } } })).to.equal("nope");
    expect(rpcErrorMessage({ shortMessage: "short", message: "long" })).to.equal("short");
    expect(rpcErrorMessage(new Error("plain"))).to.equal("plain");
    expect(rpcErrorMessage("string error")).to.equal("string error");
  });
});
