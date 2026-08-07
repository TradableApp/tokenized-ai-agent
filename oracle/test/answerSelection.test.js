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
