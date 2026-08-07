import { describe, expect, it } from "bun:test";

import { handleChainSynthesis, SYNTHESIS_TIMEOUT_MS } from "../utils/actionChainHelper";

// Action-chain synthesis — CU-86d3z0r81, harness port Phase 1.2 (re-scoped).
//
// WHY THIS IS A PORT AND NOT A DESIGN. sense-ai-core answers a tool-using prompt through
// `utils/actionChainHelper.ts::handleChainSynthesis`: at the last step of the action chain it
// re-composes state, renders `chainSynthesisTemplate` (which carries {{providers}} AND the
// accumulated action results), generates with `generateSanitized` so a template/meta leak is
// RETRIED with a nudge rather than shipped, parses the XML, and falls back to a safe sentence if
// every attempt leaks. Tool output is raw material; it is never itself the reply.
//
// The oracle's first attempt at this re-invented all six of those steps and dropped {{providers}}
// entirely — synthesising without the market-intelligence context the providers exist to supply,
// which is most of what the user paid for. These tests pin the ported behaviour so the divergence
// cannot come back.
//
// The one addition over core is `withTimeout` around the model call. That is not an oracle
// invention either: core already ships `utils/withTimeout.ts`, written for the ROFL TEE hang where
// a connection opens and never responds, so a bare await never rejects and never returns. Core
// simply has not applied it here yet — an improvement to offer back rather than a fork.

const ACTION_RESULT = {
  data: { actionName: "GET_NEWS_DETAILS", headlines: ["BTC ETF inflows accelerate"] },
  success: true,
} as never;

const MESSAGE = {
  id: "m1",
  content: { text: "What is the latest news on Bitcoin?", source: "oracle" },
  roomId: "r1",
} as never;

/** Minimal runtime: only what the helper touches. */
function buildRuntime(replies: Array<string | Error | "hang">) {
  const prompts: string[] = [];
  let call = 0;
  return {
    prompts,
    get callCount() {
      return call;
    },
    agentId: "agent-1",
    character: { name: "SenseAI" },
    composeState: async () => ({
      values: { agentName: "SenseAI", providers: "MARKET_INTELLIGENCE: BTC dominance 54%." },
      data: {},
      text: "MARKET_INTELLIGENCE: BTC dominance 54%.",
    }),
    useModel: async (_type: string, params: { prompt: string }) => {
      prompts.push(params.prompt);
      const reply = replies[Math.min(call, replies.length - 1)];
      call += 1;
      if (reply instanceof Error) throw reply;
      if (reply === "hang") return await new Promise(() => {});
      return reply;
    },
  } as never;
}

function xml(text: string, thought = "reasoning") {
  return `<response><thought>${thought}</thought><text>${text}</text></response>`;
}

/** Collects what the helper delivered, the way the oracle's onResponse would. */
function collector() {
  const sent: Array<Record<string, unknown>> = [];
  const callback = async (content: Record<string, unknown>) => {
    sent.push(content);
    return [];
  };
  return { sent, callback: callback as never };
}

describe("handleChainSynthesis (ported from sense-ai-core)", () => {
  it("passes data forward without generating when it is not the last step", async () => {
    // Mid-chain the action's data feeds the NEXT action. Synthesising here would both waste a
    // paid LLM call and deliver a partial answer before the chain finished.
    const runtime = buildRuntime([xml("premature")]);
    const { sent, callback } = collector();

    await handleChainSynthesis(
      runtime,
      MESSAGE,
      ACTION_RESULT,
      undefined,
      { actionPlan: { currentStep: 1, totalSteps: 2 } } as never,
      callback
    );

    expect(runtime.callCount, "must not call the model mid-chain").toBe(0);
    expect(sent.length).toBe(0);
  });

  it("puts the providers AND the action results in front of the model", async () => {
    // THE REGRESSION THAT MATTERS. The first oracle attempt hand-rolled a prompt with only the
    // question and the raw results — no {{providers}} — so it synthesised without the market
    // intelligence the providers exist to supply. Both must reach the prompt.
    const runtime = buildRuntime([xml("Bitcoin ETF inflows are accelerating.")]);
    const { callback } = collector();

    await handleChainSynthesis(runtime, MESSAGE, ACTION_RESULT, undefined, undefined, callback);

    const prompt = runtime.prompts[0];
    expect(prompt, "provider context must be composed in").toContain("BTC dominance 54%");
    expect(prompt, "action results must be composed in").toContain("BTC ETF inflows accelerate");
  });

  it("re-requests the providers the intermediate responses already used", async () => {
    // Core gathers provider names off `responses` and feeds them back into composeState, so the
    // synthesis pass sees the SAME context the action-selection pass did. Drop this and synthesis
    // silently runs against a thinner state than the step that chose the action.
    const runtime = buildRuntime([xml("Bitcoin ETF inflows are accelerating.")]);
    const { callback } = collector();
    const requested: string[][] = [];
    (runtime as unknown as { composeState: unknown }).composeState = async (
      _m: unknown,
      names: string[]
    ) => {
      requested.push(names);
      return { values: {}, data: {}, text: "" };
    };

    await handleChainSynthesis(
      runtime,
      MESSAGE,
      ACTION_RESULT,
      undefined,
      undefined,
      callback,
      [{ content: { providers: ["MARKET_INTELLIGENCE", "MACRO_SENTIMENT"] } }] as never
    );

    expect(requested[0]).toContain("MARKET_INTELLIGENCE");
    expect(requested[0]).toContain("MACRO_SENTIMENT");
    // Core's own two are always appended.
    expect(requested[0]).toContain("RECENT_MESSAGES");
    expect(requested[0]).toContain("ACTION_STATE");
  });

  it("delivers the synthesised prose through the callback, tagged with the action", async () => {
    const runtime = buildRuntime([xml("Bitcoin ETF inflows are accelerating.")]);
    const { sent, callback } = collector();

    await handleChainSynthesis(runtime, MESSAGE, ACTION_RESULT, undefined, undefined, callback);

    expect(sent.length).toBe(1);
    expect(sent[0].text).toBe("Bitcoin ETF inflows are accelerating.");
    expect(sent[0].actions).toEqual(["GET_NEWS_DETAILS"]);
    expect(sent[0].thought).toBe("reasoning");
  });

  it("retries with a nudge when the first attempt leaks template text", async () => {
    // sanitizeOutboundText rejects a reply whose <text> carries stray tags. Core RETRIES with
    // XML_RETRY_NUDGE rather than discarding the turn — on a pre-paid prompt a retry is far
    // cheaper than a wasted answer.
    const runtime = buildRuntime([
      xml("<response>nested leak</response>"),
      xml("Bitcoin ETF inflows are accelerating."),
    ]);
    const { sent, callback } = collector();

    await handleChainSynthesis(runtime, MESSAGE, ACTION_RESULT, undefined, undefined, callback);

    expect(runtime.callCount, "must retry the leaking attempt").toBe(2);
    expect(runtime.prompts[1], "retry must carry the corrective nudge").toContain(
      "previous response was rejected"
    );
    expect(sent[0].text).toBe("Bitcoin ETF inflows are accelerating.");
  });

  it("captures the thought from the attempt that passed, not the discarded one", async () => {
    // Otherwise the logged reasoning trail describes an answer the user never received.
    const runtime = buildRuntime([
      xml("<response>nested leak</response>", "leaking thought"),
      xml("Bitcoin ETF inflows are accelerating.", "clean thought"),
    ]);
    const { sent, callback } = collector();

    await handleChainSynthesis(runtime, MESSAGE, ACTION_RESULT, undefined, undefined, callback);

    expect(sent[0].thought).toBe("clean thought");
  });

  it("falls back to a safe sentence when every attempt leaks", async () => {
    // Silence is the one unacceptable outcome: the prompt is already paid for on-chain and the
    // answer is immutable. A plain "try again" beats an empty MessageFile.
    const runtime = buildRuntime([xml("<response>leak</response>")]);
    const { sent, callback } = collector();

    await handleChainSynthesis(runtime, MESSAGE, ACTION_RESULT, undefined, undefined, callback);

    expect(runtime.callCount).toBe(2);
    expect(sent.length, "must still deliver something").toBe(1);
    expect(String(sent[0].text).length).toBeGreaterThan(10);
    expect(sent[0].text).not.toContain("<");
  });

  it("falls back rather than throwing when the model errors", async () => {
    // Never throw into the answer path — the caller has already charged the user.
    const runtime = buildRuntime([new Error("model unavailable")]);
    const { sent, callback } = collector();

    await handleChainSynthesis(runtime, MESSAGE, ACTION_RESULT, undefined, undefined, callback);

    expect(sent.length).toBe(1);
    expect(String(sent[0].text).length).toBeGreaterThan(10);
  });

  it("keeps the synthesis deadline within the caller's budget", async () => {
    // A hang never REJECTS, so try/catch cannot save it — the turn simply stops, on a prompt
    // already charged for on-chain. `withTimeout` converts the hang into a bounded rejection,
    // which the fallback path then turns into a delivered answer. Those two links are covered
    // behaviourally elsewhere:
    //   hang → rejection    withTimeout.test.ts (ported from core, 100% covered)
    //   rejection → answer  "falls back rather than throwing when the model errors", above
    //
    // What this pins is the BUDGET, which neither of those covers and which is easy to break by
    // accident: generateSanitized retries once, so the worst case is TWO full deadlines. If the
    // constant grows past half the caller's budget, a leaking first attempt turns into a
    // stranded prompt — the exact failure the deadline exists to prevent.
    //
    // (Wiring — that this constant is the one actually passed to withTimeout — is deliberately
    // NOT asserted here. Reading the source off disk to check it, as an earlier revision did, is
    // an implementation-shape test that breaks on a rename or an extracted helper without any
    // behaviour changing. Driving it properly needs mock.module, and bun's module mocks are
    // process-global and do not rebind after load, so the stub leaks into every sibling
    // assertion in this file — verified: it collapsed six of them to the fallback.)
    const MAX_ATTEMPTS = 2;
    expect(Number.isFinite(SYNTHESIS_TIMEOUT_MS)).toBe(true);
    expect(SYNTHESIS_TIMEOUT_MS).toBeGreaterThan(0);
    expect(
      SYNTHESIS_TIMEOUT_MS * MAX_ATTEMPTS,
      "two attempts must still fit inside ElizaOS's 90s pipeline guard"
    ).toBeLessThanOrEqual(90_000);
  });

  it("holds no cross-call state — concurrent syntheses do not mix", async () => {
    // The oracle drains prompts through a p-queue at concurrency 5; core's helper was written for
    // a chat loop with one turn in flight. Anything module-level here would interleave one user's
    // answer into another's immutable, already-paid-for MessageFile.
    const slow = buildRuntime([xml("Bitcoin ETF inflows accelerated this week.")]);
    const fast = buildRuntime([xml("Ethereum staking yields compressed further.")]);
    const a = collector();
    const b = collector();

    await Promise.all([
      handleChainSynthesis(slow, MESSAGE, ACTION_RESULT, undefined, undefined, a.callback),
      handleChainSynthesis(fast, MESSAGE, ACTION_RESULT, undefined, undefined, b.callback),
    ]);

    expect(a.sent[0].text).toBe("Bitcoin ETF inflows accelerated this week.");
    expect(b.sent[0].text).toBe("Ethereum staking yields compressed further.");
  });
});
