const { expect } = require("chai");

const { synthesizeAnswer } = require("../src/answerSynthesis");

// Answer synthesis — CU-86d3z0r81, harness port Phase 1.2.
//
// WHAT 1.1 LEFT UNSOLVED. selectAnswer stopped a CALL_MCP_TOOL payload being stored, but the
// oracle still cannot turn a tool RESULT into an answer — so a tool-using prompt now returns the
// acknowledgement ("Analysing current market intelligence. Stand by."). Honest, but useless: the
// user paid for analysis and got a status message.
//
// sense-ai-core closes this with utils/actionChainHelper.ts::handleChainSynthesis — when the
// action chain reaches its last step it re-composes state, feeds the ACTION RESULTS into a
// synthesis prompt, and generates the user-facing text from them. Tool output is never itself
// user-facing; it is raw material.
//
// This module is the oracle's equivalent, kept separate from the ElizaOS action plumbing so the
// rule is testable without a runtime. Two constraints the oracle adds over core:
//
//   PAID PATH. Synthesis is an extra LLM call before the user gets anything. It must be bounded
//   and must DEGRADE rather than fail — falling back to 1.1's selection is a worse answer;
//   throwing is no answer at all, on a prompt already charged for.
//
//   CONCURRENCY. Core's helper assumes one turn in flight; the oracle drains prompts through a
//   p-queue at concurrency 5. Nothing here may hold cross-call state.

const ACTION_RESULTS = [
  {
    actionName: "CALL_MCP_TOOL",
    data: { headlines: ["BTC ETF inflows accelerate", "ETH staking yield dips"] },
  },
];

/** Minimal runtime: only what synthesis touches. */
function runtimeWith({ reply, delayMs = 0, fail = false }) {
  const calls = [];
  return {
    calls,
    useModel: async (_type, params) => {
      calls.push(params);
      if (fail) throw new Error("model unavailable");
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return reply;
    },
  };
}

describe("answer synthesis", () => {
  it("generates prose from the action results, not from the raw payload", async () => {
    // The whole point: the tool's data becomes an ANSWER, never the answer itself.
    const runtime = runtimeWith({
      reply: "<response><thought>Summarising</thought><text>Bitcoin ETF inflows are accelerating while ETH staking yields dip.</text></response>",
    });

    const answer = await synthesizeAnswer(runtime, {
      prompt: "What is the latest news on Bitcoin?",
      actionResults: ACTION_RESULTS,
    });

    expect(answer).to.equal("Bitcoin ETF inflows are accelerating while ETH staking yields dip.");
    expect(answer).to.not.match(/```|client\./);
  });

  it("puts the action results in front of the model", async () => {
    // If the results are not in the prompt, synthesis is just a second guess at the question —
    // which is how a plausible-but-unfounded answer reaches immutable storage.
    const runtime = runtimeWith({ reply: "<response><text>ok</text></response>" });

    await synthesizeAnswer(runtime, { prompt: "news?", actionResults: ACTION_RESULTS });

    const sent = JSON.stringify(runtime.calls[0]);
    expect(sent).to.include("BTC ETF inflows accelerate");
  });

  it("returns null when the model fails, so the caller can fall back", async () => {
    // Degrade, never throw: the prompt is already paid for. The caller keeps 1.1's selection.
    const runtime = runtimeWith({ reply: "", fail: true });
    expect(await synthesizeAnswer(runtime, { prompt: "p", actionResults: ACTION_RESULTS })).to.equal(null);
  });

  it("returns null rather than hanging when the model exceeds the deadline", async () => {
    // An unbounded call on the paid path is how a prompt times out on-chain with no answer at
    // all. Bounded and degraded beats correct-but-too-late.
    const runtime = runtimeWith({ reply: "<response><text>late</text></response>", delayMs: 80 });
    const answer = await synthesizeAnswer(runtime, {
      prompt: "p",
      actionResults: ACTION_RESULTS,
      timeoutMs: 20,
    });
    expect(answer).to.equal(null);
  });

  it("returns null when there are no action results to synthesise from", async () => {
    // No tool ran, so there is nothing to add — the caller's existing selection stands, and
    // spending an LLM call to restate it would be latency for nothing.
    const runtime = runtimeWith({ reply: "<response><text>unused</text></response>" });
    expect(await synthesizeAnswer(runtime, { prompt: "p", actionResults: [] })).to.equal(null);
    expect(runtime.calls.length, "must not call the model at all").to.equal(0);
  });

  it("returns null when the model reply carries no usable text", async () => {
    // A malformed or empty XML reply must not become an empty answer.
    const runtime = runtimeWith({ reply: "<response><thought>only a thought</thought></response>" });
    expect(await synthesizeAnswer(runtime, { prompt: "p", actionResults: ACTION_RESULTS })).to.equal(null);
  });

  it("holds no cross-call state — concurrent syntheses do not mix", async () => {
    // The oracle drains prompts at p-queue concurrency 5. Core's helper was written for a chat
    // loop with one turn in flight; anything module-level here would interleave one user's
    // answer into another's immutable, already-paid-for MessageFile.
    const slow = runtimeWith({ reply: "<response><text>ANSWER-A</text></response>", delayMs: 40 });
    const fast = runtimeWith({ reply: "<response><text>ANSWER-B</text></response>" });

    const [a, b] = await Promise.all([
      synthesizeAnswer(slow, { prompt: "A", actionResults: ACTION_RESULTS }),
      synthesizeAnswer(fast, { prompt: "B", actionResults: ACTION_RESULTS }),
    ]);

    expect(a).to.equal("ANSWER-A");
    expect(b).to.equal("ANSWER-B");
  });
});
