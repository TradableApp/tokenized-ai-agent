const { expect } = require("chai");

const { selectAnswer, looksLikeToolPayload } = require("../src/answerSelection");

// Answer selection — CU-86d3z0r81, harness port Phase 1.
//
// THE BUG THIS EXISTS FOR, observed on the live base-testnet TEE. Asked "What is the
// latest news on Bitcoin?", the oracle stored this as the user's answer:
//
//     ```typescript
//     async function run(client: any) {
//       const news = await client.news.get({ coin_id: 'bitcoin' });
//       console.log(JSON.stringify(news.slice(0, 3)));
//     }
//     ```
//
// 164 characters of MCP tool-call code, encrypted into an immutable MessageFile and paid
// for on-chain. The model was NOT at fault — it emitted exactly the right thing:
//
//     <thought>…acknowledge the request…then query CoinGecko…</thought>
//     <actions>REPLY,CALL_MCP_TOOL</actions>
//     <text>Analysing current market intelligence and live data feeds. Stand by. 🔍</text>
//
// The defect is aiAgentOracle.js:932 — `finalResponseText = content.text` on every
// onResponse, so LAST WRITER WINS. The acknowledgement is emitted first, the action's
// output arrives after, and whatever happens to be last becomes the answer. A previous
// run stored an apology the same way.
//
// sense-ai-core does not have this problem: `utils/actionChainHelper.ts` runs a
// Callback + Internal Synthesis pass, so action results feed a synthesis prompt and the
// tool output is never itself user-facing. The oracle has never had it — its plugin
// descends from the ElizaOS QuickStart template, not from core's.
//
// This module is the seam. It decides WHICH emitted text may become the stored answer,
// so the rule is testable in isolation and independent of the runtime's callback order.

describe("answer selection", () => {
  describe("looksLikeToolPayload", () => {
    it("recognises a fenced code block as a tool payload, not an answer", () => {
      // The exact shape that reached storage.
      const payload =
        "```typescript\nasync function run(client: any) {\n" +
        "  const news = await client.news.get({ coin_id: 'bitcoin' });\n}\n```";
      expect(looksLikeToolPayload(payload)).to.equal(true);
    });

    it("recognises a bare MCP invocation without fences", () => {
      // Not every leak arrives fenced; the model sometimes emits the call directly.
      expect(looksLikeToolPayload("await client.news.get({ coin_id: 'bitcoin' })")).to.equal(true);
    });

    it("does NOT flag prose that merely mentions code or tools", () => {
      // The oracle answers questions ABOUT crypto tooling. Rejecting any answer that
      // says "function" or "API" would silently drop legitimate analysis — a worse
      // failure than the one being fixed, because it would look like a model problem.
      const prose =
        "Bitcoin's on-chain activity rose 12% this week. The CoinGecko API shows " +
        "volume concentrated in Asian trading hours, which typically precedes volatility.";
      expect(looksLikeToolPayload(prose)).to.equal(false);
    });

    it("does NOT flag a real answer that quotes a code block", () => {
      // THE LATENT CONFLICT, caught in review of this PR. chainSynthesisTemplate — core's text,
      // ported verbatim in this same change — instructs the model to wrap any code it includes
      // in fenced blocks. Once Phase 2 wires synthesis in, its output arrives through the SAME
      // onResponse callback as everything else. A filter that rejects any text containing a
      // fence would silently swap that answer for "Analysing… stand by.", which reads as the
      // model regressing rather than as a harness bug.
      const answer =
        "Bitcoin ETF inflows accelerated 18% this week while spot volume thinned. " +
        "You can verify the flows yourself:\n" +
        "```js\nawait client.news.get({ coin_id: 'bitcoin' });\n```\n" +
        "The divergence between flow and volume rarely lasts.";
      expect(looksLikeToolPayload(answer)).to.equal(false);
    });

    it("does not flag a short but real answer that names a method call", () => {
      // The prose floor's calibration, pinned from the side that matters. Stripping the call
      // leaves 20 alphanumeric characters here — a terse answer, but an answer. Condemning it
      // stores the acknowledgement instead, which is silent and reads as the model regressing:
      // the precise failure MIN_PROSE_CHARS' asymmetry exists to avoid. Phase 2 makes this more
      // likely, since handlers synthesise from shorter chains than chainSynthesisTemplate does.
      expect(looksLikeToolPayload("Call client.news.get() for the latest feed.")).to.equal(false);
    });

    it("still flags a payload padded with a token amount of prose", () => {
      // "Here you go:" is not an answer. Stripping the code has to leave something substantive.
      const padded = "Here you go:\n```typescript\nawait client.news.get({ coin_id: 'btc' });\n```";
      expect(looksLikeToolPayload(padded)).to.equal(true);
    });

    it("does not let one invocation swallow the prose that follows it", () => {
      // Regression on the argument-body match being lazy rather than greedy. Greedy runs from
      // the first `{` to the LAST `}` in the text, so a call early in an answer eats every
      // sentence after it and the prose check then sees an empty string.
      const answer =
        "await client.news.get({ coin_id: 'bitcoin' }) returned three headlines. " +
        "Inflows are accelerating while spot volume thins, and the gap usually closes { fast }.";
      expect(looksLikeToolPayload(answer)).to.equal(false);
    });

    it("recognises payloads whose calls are not shaped like the live incident", () => {
      // The pattern originally demanded an object-literal argument, which matched the recorded
      // payload exactly and nothing else — a no-arg or positional-arg call from some future MCP
      // tool would have sailed through as prose. The live payload is one shape, not the shape.
      expect(looksLikeToolPayload("await client.news.list()")).to.equal(true);
      expect(looksLikeToolPayload("client.news.get('bitcoin')")).to.equal(true);
    });

    it("recognises a raw JSON tool RESULT, not just a tool CALL", () => {
      // The classifier was built around the recorded incident, which was a tool *invocation*. A
      // tool's raw *return value* has no fence and no call in it, so it slipped through as prose
      // and would have been stored as the paid answer.
      expect(looksLikeToolPayload('{"news": [{"title": "BTC ETF inflows"}]}')).to.equal(true);
      expect(looksLikeToolPayload('[{"symbol":"BTC","price":61000}]')).to.equal(true);
    });

    it("does not treat prose or a bare number as a JSON payload", () => {
      // JSON.parse accepts primitives, so the check requires an object or array. A one-word
      // answer is a poor answer, not a payload — and dropping it would be the worse error.
      expect(looksLikeToolPayload("61000")).to.equal(false);
      expect(looksLikeToolPayload("true")).to.equal(false);
      expect(
        looksLikeToolPayload(
          "Bitcoin is consolidating near $61k, and exchange balances keep falling.",
        ),
      ).to.equal(false);
    });

    it("recognises a call on a capitalised client object", () => {
      // `\b` cannot re-anchor inside `SDK`, and `fetchNews(` has no dot before its parenthesis,
      // so a lower-case-only leading class made this shape invisible. `SDK.news.get(…)` matched
      // only by luck, via the `news.get(…)` sub-match — which is why the gap survived the first
      // widening.
      expect(looksLikeToolPayload("SDK.fetchNews({ coin_id: 'bitcoin' })")).to.equal(true);
      expect(looksLikeToolPayload("await SDK.fetchNews({ coin_id: 'bitcoin' })")).to.equal(true);
    });

    it("does not flag prose that happens to contain parentheses", () => {
      // The widened pattern still requires the parenthesis to follow a dotted identifier
      // immediately, and the prose floor backs it up.
      const prose =
        "Bitcoin's on-chain activity (per Glassnode) rose 12% this week, and exchange " +
        "balances fell to a multi-year low.";
      expect(looksLikeToolPayload(prose)).to.equal(false);
    });

    it("gives the same verdict when called repeatedly on the same text", () => {
      // Regression guard on regex state. `/g` regexes are stateful: `.test()` advances lastIndex
      // and the next call resumes from there, so the SECOND call on identical input can return
      // the opposite answer. `.replace()` is immune, which is what makes it easy to introduce and
      // hard to see — it would present as a flaky classifier, not as a regex bug. Selection runs
      // this over every emission of every prompt, so a stateful pattern would mis-classify
      // roughly every other one.
      const payload = "```typescript\nawait client.news.get({ coin_id: 'bitcoin' });\n```";
      const answer =
        "Bitcoin ETF inflows accelerated 18% this week while spot volume thinned noticeably.";

      for (let i = 0; i < 3; i += 1) {
        expect(looksLikeToolPayload(payload), `payload, call ${i + 1}`).to.equal(true);
        expect(looksLikeToolPayload(answer), `answer, call ${i + 1}`).to.equal(false);
      }
    });

    it("does not flag an empty or missing value", () => {
      expect(looksLikeToolPayload("")).to.equal(false);
      expect(looksLikeToolPayload(undefined)).to.equal(false);
    });
  });

  describe("selectAnswer — attribution (C.0)", () => {
    // WHY ATTRIBUTION IS NEEDED AT ALL. ElizaOS picks the actions at runtime from the prompt, so
    // a turn is 0..N callbacks in an order we do not control, and each emitter tags its callback
    // with its origin (`actions: ["GET_NEWS_DETAILS"]`, `["CALL_MCP_TOOL"]`, …).
    //
    // Core never has to choose — every callback becomes its own chat message. The oracle must
    // collapse them into ONE immutable stored answer, and "last substantive prose" gets that
    // wrong for a mixed chain: plugin-mcp's handleToolResponse runs a reasoning prompt and emits
    // PROSE, so if the model orders GET_NEWS_DETAILS before CALL_MCP_TOOL, MCP's summary lands
    // last and silently replaces our synthesis on an answer the user has paid for.
    //
    // Mixed chains are DESIRABLE — a news answer is better with a live price beside it — so the
    // fix is to prefer our synthesis, never to keep MCP away from news.

    it("prefers our synthesis over a later third-party emission", () => {
      const emitted = [
        { text: "Analysing current market feeds for Bitcoin.", actions: ["REPLY"] },
        {
          text: "Bitcoin ETF inflows accelerated 18% while spot volume thinned; the divergence rarely lasts.",
          actions: ["GET_NEWS_DETAILS"],
        },
        { text: "The current price of Bitcoin is $61,204.", actions: ["CALL_MCP_TOOL"] },
      ];
      expect(selectAnswer(emitted)).to.equal(emitted[1].text);
    });

    it("falls back to last substantive prose when nothing of ours emitted", () => {
      // The chain ran, but only third-party actions spoke. Their prose is still an answer, and
      // withholding it is never an option — the user has already paid.
      const emitted = [
        { text: "Analysing current market feeds for Bitcoin.", actions: ["REPLY"] },
        { text: "The current price of Bitcoin is $61,204.", actions: ["CALL_MCP_TOOL"] },
      ];
      expect(selectAnswer(emitted)).to.equal(emitted[1].text);
    });

    it("never prefers an attributed emission that is a tool payload", () => {
      // Attribution outranks recency, but not substance: a payload is not an answer whoever
      // emitted it.
      const emitted = [
        { text: "Analysing current market feeds for Bitcoin.", actions: ["REPLY"] },
        { text: "```ts\nawait client.news.get({});\n```", actions: ["GET_NEWS_DETAILS"] },
      ];
      expect(selectAnswer(emitted)).to.equal(emitted[0].text);
    });

    it("still accepts plain strings", () => {
      // Attribution is additive. Callers that have no tags — and every existing test — keep
      // working on the last-substantive rule.
      expect(selectAnswer(["ack", "Bitcoin is consolidating near $61k."])).to.equal(
        "Bitcoin is consolidating near $61k.",
      );
    });

    it("picks the LAST synthesis emission when one action emits more than once", () => {
      // `handleChainSynthesis` tags every callback it makes with the same actionName, and an
      // action is free to emit an interim before its synthesis — `analyzeAssetSentiment` does
      // exactly that ("Extracting institutional-grade data for BTC..."), and its interim is
      // PROSE, so the payload filter cannot separate the two.
      //
      // Last-wins is therefore load-bearing rather than incidental: first-wins would store the
      // interim and silently discard the answer, which is a strictly worse version of the bug
      // this file exists to fix. Left untested, a reasonable-looking change to `[0]` would keep
      // every other case here green.
      const emitted = [
        { text: "Fetching the latest news on Bitcoin...", actions: ["GET_NEWS_DETAILS"] },
        {
          text: "Bitcoin ETF inflows accelerated 18% while spot volume thinned.",
          actions: ["GET_NEWS_DETAILS"],
        },
        { text: "The current price of Bitcoin is $61,204.", actions: ["CALL_MCP_TOOL"] },
      ];
      expect(selectAnswer(emitted)).to.equal(emitted[1].text);
    });

    it("stores an apology rather than nothing, attributed or not", () => {
      // THE STANDING INVARIANT: no quality rule may turn an answer into no-answer. An apology is
      // a poor answer; silence is a failed contract on a prompt that has already been charged.
      const emitted = [{ text: "I'm sorry, I cannot help with that.", actions: ["REPLY"] }];
      expect(selectAnswer(emitted)).to.equal("I'm sorry, I cannot help with that.");
    });
  });

  describe("selectAnswer", () => {
    it("never returns a tool payload when prose was also emitted", () => {
      // THE REGRESSION TEST. Acknowledgement first, tool payload last — last-writer-wins
      // stored the payload. Ordering must not decide what the user is charged for.
      const emitted = [
        "Analysing current market intelligence and live data feeds for Bitcoin. Stand by. 🔍",
        "```typescript\nawait client.news.get({ coin_id: 'bitcoin' });\n```",
      ];
      const answer = selectAnswer(emitted);
      expect(answer).to.not.match(/```/);
      expect(answer).to.equal(emitted[0]);
    });

    it("keeps a synthesised answer that quotes code, rather than the acknowledgement", () => {
      // The success path once Phase 2 lands: ack → tool payload → synthesis. The synthesis wins
      // even though it contains a fence, because it is an answer WITH code, not code alone.
      const emitted = [
        "Analysing current market intelligence for Bitcoin. Stand by. 🔍",
        "```typescript\nawait client.news.get({ coin_id: 'bitcoin' });\n```",
        "Inflows accelerated 18% while spot volume thinned. Verify with " +
          "```js\nclient.news.get({ coin_id: 'bitcoin' });\n``` if you want the raw feed.",
      ];
      expect(selectAnswer(emitted)).to.equal(emitted[2]);
    });

    it("prefers the LAST substantive response, not merely the first", () => {
      // The acknowledgement is not the answer either. When the agent genuinely answers
      // after acknowledging, the real answer is the later one — so this cannot be fixed
      // by naively taking emitted[0].
      const emitted = [
        "Fetching the latest Bitcoin data. One moment. 🔍",
        "Bitcoin is consolidating near $61k with declining volume; momentum indicators are neutral.",
      ];
      expect(selectAnswer(emitted)).to.equal(emitted[1]);
    });

    it("falls back to the tool payload rather than returning nothing", () => {
      // Degrading to a bad answer beats degrading to NO answer: the user has already
      // paid, and an empty response fails the contract entirely. Better to surface
      // something and let the smoke test flag it.
      const emitted = ["```typescript\nawait client.news.get({});\n```"];
      expect(selectAnswer(emitted)).to.equal(emitted[0]);
    });

    it("ignores empty and whitespace-only emissions", () => {
      const emitted = ["", "   ", "Bitcoin is consolidating near $61k."];
      expect(selectAnswer(emitted)).to.equal("Bitcoin is consolidating near $61k.");
    });

    it("returns null when nothing was emitted at all", () => {
      // queryElizaOS already rejects with "completed but generated no text"; this keeps
      // that behaviour reachable rather than inventing an empty answer.
      expect(selectAnswer([])).to.equal(null);
      expect(selectAnswer(undefined)).to.equal(null);
    });
  });
});
