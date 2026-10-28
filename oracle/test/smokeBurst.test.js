const { expect } = require("chai");

// Burst mode (CU-14ym9bvdmjr): N prompts from N accounts at once, exercising the oracle's
// p-queue and tx mutex. The contract reverts a second submitAnswer for the same id, so
// "duplicated" can only show as cross-wiring — the same CID or id landing on two prompts — or
// as more than one AnswerMessageAdded log for one id. This is the judgement over the results.

const { assertOneAnswerPerPrompt } = require("../scripts/smoke/burst.js");

const result = (i, over = {}) => ({
  index: i,
  account: `0x${String(i).padStart(40, "0")}`,
  conversationId: String(100 + i),
  answerMessageId: String(200 + i),
  cid: `bafkr6i${"a".repeat(40)}${i}`,
  answerEventCount: 1,
  ...over,
});

describe("smoke: assertOneAnswerPerPrompt", () => {
  it("passes when every prompt has its own id, one event and its own CID", () => {
    const v = assertOneAnswerPerPrompt([result(0), result(1), result(2)]);
    expect(v.ok).to.equal(true);
    expect(v.problems).to.deep.equal([]);
  });

  it("names a CID that landed on two prompts (cross-wired answers)", () => {
    const shared = `bafkr6i${"z".repeat(41)}`;
    const v = assertOneAnswerPerPrompt([result(0, { cid: shared }), result(1, { cid: shared }), result(2)]);
    expect(v.ok).to.equal(false);
    expect(v.problems.join("\n")).to.match(/CID .*shared by prompts 0, 1/);
  });

  it("names an answer id that appears twice", () => {
    const v = assertOneAnswerPerPrompt([result(0), result(1, { answerMessageId: "200" })]);
    expect(v.ok).to.equal(false);
    expect(v.problems.join("\n")).to.match(/answerMessageId 200 .*prompts 0, 1/);
  });

  it("names a prompt with more than one AnswerMessageAdded log, or none", () => {
    const v = assertOneAnswerPerPrompt([result(0, { answerEventCount: 2 }), result(1, { answerEventCount: 0 })]);
    expect(v.ok).to.equal(false);
    expect(v.problems.join("\n")).to.match(/prompt 0 .*2 AnswerMessageAdded/);
    expect(v.problems.join("\n")).to.match(/prompt 1 .*0 AnswerMessageAdded/);
  });

  it("names a prompt that never got an answer", () => {
    const v = assertOneAnswerPerPrompt([result(0), result(1, { answerMessageId: "201", cid: undefined, answerEventCount: 0, error: "TIMEOUT" })]);
    expect(v.ok).to.equal(false);
    expect(v.problems.join("\n")).to.match(/prompt 1 .*TIMEOUT/);
  });

  it("requires the count it was promised", () => {
    const v = assertOneAnswerPerPrompt([result(0), result(1)], { expected: 3 });
    expect(v.ok).to.equal(false);
    expect(v.problems.join("\n")).to.match(/expected 3 .*got 2/);
  });
});
