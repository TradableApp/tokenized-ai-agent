const { expect } = require("chai");

// Plan activation in the Base-testnet smoke script (CU-86d438hwt).
//
// THE BUG THIS PINS, hit on 2026-08-22. The previous day's `+1 day` spending limit had lapsed,
// so the script correctly set a fresh one and awaited the receipt — then `initiatePrompt`
// immediately reverted with `SpendingLimitExpired()`.
//
// `.wait()` resolves on ONE confirmation from whichever node in Base Sepolia's load-balanced
// pool served the request. ethers then runs `eth_estimateGas` for the next call, which can land
// on a DIFFERENT node that is a block or two behind and still sees no limit. The write was fine;
// the read raced it.
//
// So confirming the receipt is not the same as confirming the state is READABLE. Re-read
// `spendingLimits` until the plan actually shows up, and only then submit.
//
// The second half of this is legibility: the revert surfaced as the bare selector `0x26575023`,
// which took a manual 4-byte lookup to identify. The escrow's custom errors now live in the ABI
// so ethers names them.

const {
  ensurePlanActive,
  ESCROW_ABI,
} = require("../scripts/base-testnet-smoke.js");

const FEE = 10n;
const CAPPED = 50n;

/** A fake escrow whose reads lag its writes by `lagReads` calls — the production failure. */
function fakeEscrow({ initial, lagReads = 0 }) {
  let stored = initial;
  let remainingLag = 0;
  const calls = { setSpendingLimit: 0, spendingLimits: 0 };
  return {
    calls,
    async spendingLimits() {
      calls.spendingLimits += 1;
      if (remainingLag > 0) {
        remainingLag -= 1;
        return initial; // stale node: still serving the pre-write state
      }
      return stored;
    },
    async setSpendingLimit(allowance, expiresAt) {
      calls.setSpendingLimit += 1;
      stored = { allowance, spent: 0n, expiresAt: BigInt(expiresAt) };
      remainingLag = lagReads;
      return { wait: async () => ({ status: 1 }) };
    },
  };
}

const NOW = 1_800_000_000;
const LIVE = { allowance: 100n, spent: 0n, expiresAt: BigInt(NOW + 86400) };
const EXPIRED = { allowance: 100n, spent: 0n, expiresAt: BigInt(NOW - 60) };

describe("smoke: ensurePlanActive", () => {
  it("does not touch the chain when the plan is already live", async () => {
    const escrow = fakeEscrow({ initial: LIVE });
    await ensurePlanActive({ escrow, capped: CAPPED, fee: FEE, now: () => NOW, sleep: async () => {} });
    expect(escrow.calls.setSpendingLimit).to.equal(0);
  });

  it("sets a new limit when the old one has expired", async () => {
    const escrow = fakeEscrow({ initial: EXPIRED });
    await ensurePlanActive({ escrow, capped: CAPPED, fee: FEE, now: () => NOW, sleep: async () => {} });
    expect(escrow.calls.setSpendingLimit).to.equal(1);
  });

  it("WAITS for the new limit to be READABLE before returning, not just mined", async () => {
    // Two stale reads = the production race. Without a confirm-loop this returns immediately
    // and the caller's estimateGas reverts with SpendingLimitExpired().
    const escrow = fakeEscrow({ initial: EXPIRED, lagReads: 2 });
    const plan = await ensurePlanActive({
      escrow,
      capped: CAPPED,
      fee: FEE,
      now: () => NOW,
      sleep: async () => {},
    });
    expect(Number(plan.expiresAt)).to.be.greaterThan(NOW);
    // 1 initial read + at least 2 stale + 1 good.
    expect(escrow.calls.spendingLimits).to.be.at.least(4);
    // It must NOT have papered over the lag by sending the tx again.
    expect(escrow.calls.setSpendingLimit).to.equal(1);
  });

  it("throws a NAMED error rather than hanging forever if the plan never appears", async () => {
    const escrow = fakeEscrow({ initial: EXPIRED, lagReads: Number.MAX_SAFE_INTEGER });
    let err;
    try {
      await ensurePlanActive({
        escrow,
        capped: CAPPED,
        fee: FEE,
        now: () => NOW,
        sleep: async () => {},
        confirmAttempts: 3,
      });
    } catch (e) {
      err = e;
    }
    expect(err, "expected a throw").to.exist;
    expect(err.message).to.match(/spending limit/i);
  });

  it("exposes the escrow's custom errors so a revert names itself instead of printing a selector", () => {
    // `0x26575023` cost a manual 4-byte lookup during the deploy. ethers can only decode a
    // custom error it has the signature for.
    const joined = ESCROW_ABI.join("\n");
    for (const e of [
      "SpendingLimitExpired()",
      "NoActiveSpendingLimit()",
      "InsufficientSpendingLimitAllowance()",
      "ExpirationInThePast()",
      "ZeroSpendingLimit()",
    ]) {
      expect(joined, `ABI must declare ${e}`).to.contain(`error ${e}`);
    }
  });
});
