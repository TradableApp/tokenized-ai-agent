const { expect } = require("chai");

// The thin glue in the smoke script itself: per-prompt verdicts, the oracle nonce span across a
// burst, and receipt-log parsing. Everything heavier lives in scripts/smoke/* with its own suite.

const {
  judge,
  oracleNonceSpan,
  agentEvents,
  AGENT_ABI,
} = require("../scripts/base-testnet-smoke.js");
const { ethers } = require("ethers");

const GOOD = {
  role: "assistant",
  content:
    "Bitcoin slipped 2% to $61k overnight as ETF outflows continued; BTC funding rates cooled.",
  reasoning: [{ step: "news" }],
  sources: [{ title: "Reuters" }],
};
const cfg = { asset: "Bitcoin", injection: false };

describe("smoke: judge", () => {
  it("passes a good answer", () => {
    expect(judge({ answer: GOOD }, { cfg })).to.deep.equal({
      fatal: [],
      brain: [],
      verdict: "pass",
    });
  });

  it("is partial when only the Brain lists are empty", () => {
    const j = judge({ answer: { ...GOOD, reasoning: [], sources: [] } }, { cfg });
    expect(j.verdict).to.equal("partial");
    expect(j.fatal).to.deep.equal([]);
    expect(j.brain).to.have.length(2);
  });

  it("turns a run error into a single fatal", () => {
    expect(judge({ error: "TIMEOUT: no AnswerMessageAdded" }, { cfg })).to.deep.equal({
      fatal: ["TIMEOUT: no AnswerMessageAdded"],
      brain: [],
      verdict: "fail",
    });
  });

  it("routes through the injection assessor when the mode is on", () => {
    const canary = "SMOKE-CANARY-deadbeef";
    const j = judge(
      { answer: GOOD, storedPrompt: { content: "What is the latest news on Bitcoin?" } },
      { cfg: { ...cfg, injection: true }, canary },
    );
    expect(j.verdict).to.equal("fail");
    expect(j.fatal.join("\n")).to.match(/directive .*not .*stored prompt/i);
  });
});

describe("smoke: oracleNonceSpan", () => {
  it("spans the submitAnswer nonces seen across the burst", () => {
    expect(
      oracleNonceSpan([
        { answerNonce: 44 },
        { answerNonce: 42 },
        { error: "x" },
        { answerNonce: 43 },
      ]),
    ).to.deep.equal({
      before: 42,
      after: 45,
    });
  });

  it("is null when no answer was observed", () => {
    expect(oracleNonceSpan([{ error: "TIMEOUT" }])).to.equal(null);
  });
});

describe("smoke: agentEvents", () => {
  it("parses the named agent events out of a receipt and skips foreign logs", () => {
    const iface = new ethers.Interface(AGENT_ABI);
    const agent = { interface: iface };
    const mk = (name, args) => {
      const { data, topics } = iface.encodeEventLog(iface.getEvent(name), args);
      return { data, topics: [...topics] };
    };
    const receipt = {
      logs: [
        { data: "0x", topics: ["0x" + "ab".repeat(32)] }, // not an agent event
        mk("PromptMessageAdded", [7n, 70n, "bafkr6iprompt"]),
        mk("AnswerMessageAdded", [7n, 71n, "bafkr6ianswer"]),
      ],
    };
    const prompts = agentEvents(agent, receipt, "PromptMessageAdded");
    expect(prompts).to.have.length(1);
    expect(prompts[0].args.messageId).to.equal(70n);
    expect(prompts[0].args.messageCID).to.equal("bafkr6iprompt");
    expect(agentEvents(agent, receipt, "AnswerMessageAdded")[0].args.messageCID).to.equal(
      "bafkr6ianswer",
    );
    expect(agentEvents(agent, receipt, "PromptSubmitted")).to.deep.equal([]);
  });
});
