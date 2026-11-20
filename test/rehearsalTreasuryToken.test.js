const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const { forwardPhase } = require("../scripts/admin-rehearsal");
const {
  PROMPT_FEE,
  REHEARSAL_FEE,
  snapshotText,
  loadRehearsal,
  scratchFolders,
  deployRestrictedRehearsalFixture,
} = require("./helpers/rehearsalFixture");

const { scratchDir, removeScratchDirs } = scratchFolders();

// The treasury steps make the Safe the escrow's treasury for a while. A token that moves only to
// or from listed addresses refuses every payment the escrow sends to an unlisted treasury, so the
// rehearsal reads the escrow's token before it starts and refuses while the Safe is not listed.
describe("the rehearsal's treasury step and the escrow's token", function () {
  after(removeScratchDirs);

  const scratch = () => path.join(scratchDir("rehearsal-token-"), "snapshot.json");

  function forward(fixture, overrides = {}) {
    fixture.lines = [];
    return forwardPhase({
      contracts: fixture.contracts,
      signer: fixture.deployer,
      dryRun: false,
      log: (line) => fixture.lines.push(String(line)),
      safeAddress: fixture.safeContractAddress,
      rehearsalPromptFee: REHEARSAL_FEE,
      snapshotFile: scratch(),
      ...overrides,
    });
  }

  const nonceOf = (fixture) => ethers.provider.getTransactionCount(fixture.deployer.address);

  it("goes on with an ordinary token, which keeps no list, and says so", async function () {
    const fixture = await loadRehearsal();

    await forward(fixture);

    expect(fixture.lines.join("\n")).to.match(/does not restrict who it moves between/);
    expect(await fixture.contracts.escrow.treasury()).to.equal(fixture.treasury.address);
    expect(await fixture.contracts.escrow.pendingOwner()).to.equal(fixture.safeContractAddress);
  });

  for (const dryRun of [false, true]) {
    it(`refuses before anything is sent or written when the token restricts transfers and the Safe is not listed (dryRun=${dryRun})`, async function () {
      const fixture = await loadRehearsal(deployRestrictedRehearsalFixture);
      const snapshotFile = scratch();
      const nonce = await nonceOf(fixture);

      await expect(forward(fixture, { snapshotFile, dryRun })).to.be.rejectedWith(
        /is not on its list[\s\S]*Nothing was sent/,
      );

      expect(fs.existsSync(snapshotFile)).to.equal(false);
      expect(await nonceOf(fixture)).to.equal(nonce);
      expect(await fixture.contracts.escrow.promptFee()).to.equal(PROMPT_FEE);
    });
  }

  it("goes on when the token restricts transfers and the Safe is listed", async function () {
    const fixture = await loadRehearsal(deployRestrictedRehearsalFixture);
    await fixture.token
      .connect(fixture.deployer)
      .setTransferExempt(fixture.safeContractAddress, true);

    await forward(fixture);

    expect(fixture.lines.join("\n")).to.match(/is on its list/);
    expect(await fixture.contracts.escrow.treasury()).to.equal(fixture.treasury.address);
    expect(await fixture.contracts.escrow.pendingOwner()).to.equal(fixture.safeContractAddress);
  });

  // The Safe is already the treasury: refusing now would leave it there.
  it("does not stand in the way of a resumed run whose treasury set already landed", async function () {
    const fixture = await loadRehearsal(deployRestrictedRehearsalFixture);
    const snapshotFile = scratch();
    const done = { status: "done", txHash: `0x${"ab".repeat(32)}`, blockNumber: 1 };
    fs.writeFileSync(
      snapshotFile,
      await snapshotText(fixture.contracts, fixture.state, fixture.safeContractAddress, {
        steps: { "treasury-set": done },
      }),
    );
    await fixture.contracts.escrow
      .connect(fixture.deployer)
      .setTreasury(fixture.safeContractAddress);

    await forward(fixture, { snapshotFile });

    expect(await fixture.contracts.escrow.treasury()).to.equal(fixture.treasury.address);
  });

  it("refuses when it cannot tell whether the token keeps a list", async function () {
    const fixture = await loadRehearsal();
    // An address with no code answers every call with nothing, which reads as no answer.
    const escrow = new Proxy(fixture.contracts.escrow, {
      get(target, property) {
        if (property === "ableToken") return async () => fixture.stranger.address;
        return Reflect.get(target, property, target);
      },
    });
    const nonce = await nonceOf(fixture);

    await expect(
      forward(fixture, { contracts: { ...fixture.contracts, escrow } }),
    ).to.be.rejectedWith(/could not tell whether[\s\S]*Nothing was sent/);
    expect(await nonceOf(fixture)).to.equal(nonce);
  });

  describe("isEmptyRevert: the token has no such function, and nothing else", function () {
    // eslint-disable-next-line global-require
    const isEmptyRevert = (error) => require("../scripts/rehearsal/token").isEmptyRevert(error);
    const answered = (message) => ({
      code: "CALL_EXCEPTION",
      data: null,
      info: { error: { code: -32000, message } },
    });

    it("is true for a revert that carries no data", function () {
      expect(isEmptyRevert({ code: "CALL_EXCEPTION", data: "0x" })).to.equal(true);
      // A node that leaves the data out of an empty revert, and says it reverted.
      expect(isEmptyRevert(answered("execution reverted"))).to.equal(true);
      // The in-process network's own error carries the empty data and no ethers code.
      expect(
        isEmptyRevert({
          data: "0x",
          message: "Transaction reverted: function selector was not recognized",
        }),
      ).to.equal(true);
    });

    it("is false for a revert with data, a node that did not answer, and no answer", function () {
      expect(isEmptyRevert({ code: "CALL_EXCEPTION", data: "0x82b42900" })).to.equal(false);
      expect(isEmptyRevert(answered("rate limit exceeded"))).to.equal(false);
      expect(isEmptyRevert({ code: "CALL_EXCEPTION", data: null })).to.equal(false);
      expect(isEmptyRevert({ code: "SERVER_ERROR", data: "0x", message: "reverted" })).to.equal(
        false,
      );
      expect(isEmptyRevert({ code: "BAD_DATA", value: "0x" })).to.equal(false);
      expect(isEmptyRevert({ message: "Transaction reverted: custom error" })).to.equal(false);
      expect(isEmptyRevert(null)).to.equal(false);
    });

    // On a live network the read goes through Hardhat's HTTP provider, which throws its own
    // ProviderError: the node's JSON-RPC code and message, and `data` only when the node sent it.
    describe("as Hardhat's HTTP provider reports a node's answer", function () {
      // eslint-disable-next-line global-require
      const { ProviderError } = require("hardhat/internal/core/providers/errors");
      // Built the way the provider builds it from a JSON-RPC error object.
      const fromNode = ({ code, message, data }) => {
        const error = new ProviderError(message, code);
        error.data = data;
        return error;
      };

      it("is true for the node's bare revert with no data, as geth answers an empty revert", function () {
        expect(isEmptyRevert(fromNode({ code: -32000, message: "execution reverted" }))).to.equal(
          true,
        );
        expect(isEmptyRevert(fromNode({ code: -32000, message: "Execution Reverted" }))).to.equal(
          true,
        );
        expect(
          isEmptyRevert(fromNode({ code: 3, message: "execution reverted", data: "0x" })),
        ).to.equal(true);
      });

      it("is false for a revert with a reason after it, its data stripped", function () {
        const reason = fromNode({ code: -32000, message: "execution reverted: not allowed" });
        expect(isEmptyRevert(reason)).to.equal(false);
        expect(isEmptyRevert(answered("execution reverted: not allowed"))).to.equal(false);
      });

      it("is false for a revert with data, and for a node that refused the request", function () {
        const withData = fromNode({ code: 3, message: "execution reverted", data: "0x82b42900" });
        const limited = fromNode({
          code: -32005,
          message: "Too Many Requests error received from rpc.example",
        });
        expect(isEmptyRevert(withData)).to.equal(false);
        expect(isEmptyRevert(limited)).to.equal(false);
        expect(isEmptyRevert(fromNode({ code: -32000, message: "header not found" }))).to.equal(
          false,
        );
      });
    });
  });
});
