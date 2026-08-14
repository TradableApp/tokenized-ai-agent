const { expect } = require("chai");
const proxyquire = require("proxyquire").noCallThru();

// Oracle-side `daily_activity` telemetry — the writer half of PR C3 (CU-86d3z0r81).
//
// The Brain owns `recordActivity` (brain#14) and the categoriser that buckets these rows
// (brain#15); core adopted both and renders them in Slack (core#89, #90, #91). This is the last
// piece: the Oracle body actually writing.
//
// TWO TRAPS THIS FILE EXISTS TO PIN, both of which would compile, run, and be silently wrong:
//
//   1. THE DATABASE. This body holds two Postgres handles. `runtime.db` is plugin-sql's, pointed
//      at the ISOLATED `oracle_agent` database; the Brain's `ctx.db` is the shared `senseai` DB
//      where `senseai.daily_activity` actually lives. Writing through the former succeeds and
//      lands somewhere core's daily summary never reads — no error, no warning, telemetry that
//      simply never appears.
//
//   2. THE SEED PREFIX. `content_hash` is derived from `contentSeed` ALONE — `platform` and
//      `kind` are deliberately not folded in (see recordActivity's docstring). So an unprefixed
//      seed can collide with a Social row and be silently discarded by `onConflictDoNothing`.
//      Oracle seeds must be `oracle:<answerMessageId>`.
//
// Best-effort is a hard requirement, not a nicety: this runs on a paid, immutable answer path.
// Telemetry must never be able to fail a prompt the escrow has already charged for.

function load({ handles = undefined, recordActivity } = {}) {
  const calls = [];
  const impl =
    recordActivity ||
    (async (ctx, args) => {
      calls.push({ ctx, args });
    });

  const mod = proxyquire("../src/answerActivity", {
    "./brainContext": {
      getHandles: async () =>
        handles === undefined
          ? { brain: { recordActivity: impl }, ctx: { db: "SHARED_SENSEAI_DB" } }
          : handles,
    },
  });

  return { mod, calls };
}

describe("answerActivity — oracle daily_activity writer", () => {
  it("writes through the BRAIN's ctx, never the agent runtime's db", async () => {
    // TRAP 1. plugin-sql points runtime.db at `oracle_agent`; daily_activity is in the shared
    // `senseai` DB. Asserting the exact ctx object is what pins which database is written to.
    const { mod, calls } = load();

    await mod.recordAnswerActivity({ answerMessageId: 457n, kind: "answer" });

    expect(calls).to.have.lengthOf(1);
    expect(calls[0].ctx, "must be the Brain's shared-cache ctx").to.deep.equal({
      db: "SHARED_SENSEAI_DB",
    });
  });

  it("prefixes the content seed with `oracle:` so it cannot collide with a Social row", async () => {
    // TRAP 2. The hash is computed from the seed alone, so an unprefixed seed that happens to
    // match a Social one is silently swallowed by onConflictDoNothing.
    const { mod, calls } = load();

    await mod.recordAnswerActivity({ answerMessageId: 457n, kind: "answer" });

    expect(calls[0].args.contentSeed).to.equal("oracle:457");
  });

  it("records platform `oracle` and the caller's kind", async () => {
    const { mod, calls } = load();

    await mod.recordAnswerActivity({ answerMessageId: 1n, kind: "answer_failed" });

    expect(calls[0].args.platform).to.equal("oracle");
    expect(calls[0].args.kind).to.equal("answer_failed");
  });

  it("carries the wallet as targetId and the conversation in metadata", async () => {
    const { mod, calls } = load();

    await mod.recordAnswerActivity({
      answerMessageId: 457n,
      kind: "answer",
      userWallet: "0xUser",
      conversationId: 123n,
      promptMessageId: 456n,
    });

    expect(calls[0].args.targetId).to.equal("0xUser");
    expect(calls[0].args.metadata).to.deep.equal({
      conversationId: "123",
      promptMessageId: "456",
    });
  });

  it("NEVER throws when the write fails — the answer path is already paid for", async () => {
    // recordActivity is best-effort by the Brain's own contract, but this body must not depend
    // on that: a future change there cannot be allowed to fail a charged prompt from here.
    const { mod } = load({
      recordActivity: async () => {
        throw new Error("connection refused");
      },
    });

    let threw = null;
    try {
      await mod.recordAnswerActivity({ answerMessageId: 1n, kind: "answer" });
    } catch (error) {
      threw = error;
    }

    expect(threw, "telemetry must never surface on the answer path").to.equal(null);
  });

  it("no-ops when the Brain is unconfigured, rather than throwing", async () => {
    // localnet / e2e runs have no Brain at all. getHandles returns null there.
    const { mod } = load({ handles: null });

    let threw = null;
    try {
      await mod.recordAnswerActivity({ answerMessageId: 1n, kind: "answer" });
    } catch (error) {
      threw = error;
    }

    expect(threw).to.equal(null);
  });

  it("rejects a kind the Brain's categoriser does not bucket", async () => {
    // The Brain routes an unrecognised oracle kind to `unknown`, which surfaces in Slack as
    // noise. Catching a typo here is cheaper than discovering it in a daily summary — and the
    // guarantee is opt-in on this body, since RecordActivityArgs.kind is `string`
    // (CU-86d412qun would make it a compile error instead).
    const { mod, calls } = load();

    await mod.recordAnswerActivity({ answerMessageId: 1n, kind: "answr" });

    expect(calls, "a mistyped kind must not reach the ledger").to.have.lengthOf(0);
  });
});
