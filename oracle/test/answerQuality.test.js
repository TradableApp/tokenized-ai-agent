const { expect } = require("chai");

const { assessAnswer } = require("../src/answerQuality");

// Answer quality assessment — CU-86d3z0r81, harness port 1.6.
//
// WHY THE SMOKE NEEDED HARDENING. base-testnet-smoke.js asserted structure only: role is
// "assistant", content longer than 20 characters, reasoning[] and sources[] non-empty. Every one
// of those was TRUE for both recorded production failures — the answer was a fenced TypeScript
// snippet, and before that an apology — because the Brain populated reasoning and sources
// regardless of what the model actually said. The smoke reported PASS on both.
//
// A smoke that passes on the exact failures it was written to catch is worse than no smoke: it
// is a green light that costs real money to trust. So the judgement moves here, out of the
// 337-line network script, where it can be tested against the recorded failures as fixtures.
//
// THE ASYMMETRY IS DELIBERATE and inverted relative to answerSelection. There, dropping a real
// answer was the worse error because it silently swapped in the acknowledgement. Here, a false
// FAILURE is the worse error: a smoke that cries wolf gets ignored, and then it catches nothing
// at all. So every rejection below has to be defensible on the recorded evidence.

/** The Brain populates these regardless of answer quality — which is why they proved nothing. */
const ENRICHED = {
  role: "assistant",
  reasoning: [{ step: "Composed market intelligence" }],
  sources: [{ title: "BTC ETF inflows accelerate" }],
};

const ASKED = { asset: "Bitcoin" };

describe("answer quality assessment", () => {
  it("passes a substantive answer about the asset asked", () => {
    const result = assessAnswer(
      {
        ...ENRICHED,
        content:
          "Bitcoin is consolidating near $61k with declining spot volume. ETF inflows " +
          "accelerated 18% this week, but on-chain activity has not followed.",
      },
      ASKED,
    );
    expect(result.fatal, JSON.stringify(result.fatal)).to.deep.equal([]);
  });

  it("FAILS on the recorded code-block answer", () => {
    // The exact payload stored on base-testnet: 164 characters of MCP tool-call code,
    // encrypted into an immutable MessageFile and paid for on-chain. The old smoke passed it.
    const result = assessAnswer(
      {
        ...ENRICHED,
        content:
          "```typescript\nasync function run(client: any) {\n" +
          "  const news = await client.news.get({ coin_id: 'bitcoin' });\n" +
          "  console.log(JSON.stringify(news.slice(0, 3)));\n}\n```",
      },
      ASKED,
    );
    expect(result.fatal.join(" ")).to.match(/code|payload|tool/i);
  });

  it("FAILS on the recorded apology answer", () => {
    // The earlier failure, same defect, different payload.
    const result = assessAnswer(
      {
        ...ENRICHED,
        content:
          "I'm sorry, but I am unable to retrieve that information at the moment. " +
          "Please try again later.",
      },
      ASKED,
    );
    expect(result.fatal.join(" ")).to.match(/apolog|non-answer|no substance/i);
  });

  it("does NOT fail an answer that legitimately reports missing data", () => {
    // Core's own system prompt instructs the agent: 'If data is missing, say "The data isn't
    // there" and move on.' Declining IS a valid answer when it is specific and carries
    // analysis. Rejecting it would make the smoke fail on correct behaviour — and a smoke that
    // cries wolf is one that gets ignored, which costs more than the bug it was guarding.
    const result = assessAnswer(
      {
        ...ENRICHED,
        content:
          "Bitcoin funding data isn't there for the last 48 hours. What is available: spot " +
          "volume fell 12% while exchange balances kept declining, which usually precedes a " +
          "volatility expansion.",
      },
      ASKED,
    );
    expect(result.fatal, JSON.stringify(result.fatal)).to.deep.equal([]);
  });

  it("FAILS when the answer never mentions the asset asked about", () => {
    // A fluent answer about the wrong subject is the failure structure alone can never catch.
    const result = assessAnswer(
      {
        ...ENRICHED,
        content:
          "Ethereum staking yields compressed to 2.9% this week as validator queues cleared " +
          "and restaking demand cooled across the major protocols.",
      },
      ASKED,
    );
    expect(result.fatal.join(" ")).to.match(/Bitcoin/i);
  });

  it("accepts the asset named by its ticker rather than its full name", () => {
    // "BTC" is the same answer as "Bitcoin" and must not trip the asset check.
    const result = assessAnswer(
      {
        ...ENRICHED,
        content:
          "BTC is consolidating near $61k while spot volume thins. Funding flipped negative " +
          "across the majors, so traders are paying to short into a tightening float.",
      },
      ASKED,
    );
    expect(result.fatal, JSON.stringify(result.fatal)).to.deep.equal([]);
  });

  it("keeps oracle-health and cache-warmth separate", () => {
    // The existing exit-code contract: 1 = oracle broken (page someone), 2 = oracle healthy but
    // the Brain warm cache is cold (seed it). Collapsing them would page on a data problem.
    const result = assessAnswer(
      {
        role: "assistant",
        reasoning: [],
        sources: [],
        content:
          "Bitcoin is consolidating near $61k with declining volume and neutral momentum " +
          "indicators across the board.",
      },
      ASKED,
    );
    expect(result.fatal, "a cold cache is not an oracle failure").to.deep.equal([]);
    expect(result.brain.join(" ")).to.match(/reasoning|sources/i);
  });

  it("still catches the structural failures the old smoke did catch", () => {
    const wrongRole = assessAnswer({ ...ENRICHED, role: "user", content: "Bitcoin holds $61k." }, ASKED);
    expect(wrongRole.fatal.join(" ")).to.match(/role/i);

    const tooShort = assessAnswer({ ...ENRICHED, content: "Bitcoin." }, ASKED);
    expect(tooShort.fatal.join(" ")).to.match(/short|missing/i);
  });

  it("does not require an asset when the caller does not name one", () => {
    // Not every smoke prompt is asset-specific; the check must be opt-in rather than a trap.
    const result = assessAnswer(
      {
        ...ENRICHED,
        content: "Global liquidity is tightening as M2 growth stalls across the major economies.",
      },
      {},
    );
    expect(result.fatal, JSON.stringify(result.fatal)).to.deep.equal([]);
  });
});
