const { expect } = require("chai");
const { ethers, artifacts } = require("hardhat");

const { listFeeTokenExempt, TOKEN_ABI } = require("../scripts/list-fee-token-exempt");
const {
  loadRehearsal,
  deployRehearsalFixture,
  deployRestrictedRehearsalFixture,
} = require("./helpers/rehearsalFixture");

// A token that moves only to or from listed addresses refuses every fee unless the escrow and
// the treasury are listed: the escrow takes each prompt's payment and pays it on, and the
// treasury is paid fees straight from users. The script lists both after a fresh deploy, and
// --check reads the result. The fixture's pair pays in the real SENSE token, owned by the deploy
// wallet, with nothing listed; the treasury is signer 2.
describe("scripts/list-fee-token-exempt — listing the escrow and the treasury", function () {
  async function run(fixture, overrides = {}) {
    fixture.lines = [];
    return listFeeTokenExempt({
      tokenAddress: await fixture.token.getAddress(),
      escrow: fixture.contracts.escrow,
      signer: fixture.deployer,
      provider: ethers.provider,
      check: false,
      env: {},
      networkName: "hardhat",
      log: (line) => fixture.lines.push(String(line)),
      now: () => 1_700_000_000_000,
      ...overrides,
    });
  }

  const nonceOf = (signer) => ethers.provider.getTransactionCount(signer.address);
  const listed = async (fixture, address) => fixture.token.isTransferExempt(address);

  it("lists both and reads them back", async function () {
    const fixture = await loadRehearsal(deployRestrictedRehearsalFixture);
    const escrow = await fixture.contracts.escrow.getAddress();

    const result = await run(fixture);

    expect(await listed(fixture, escrow)).to.equal(true);
    expect(await listed(fixture, fixture.treasury.address)).to.equal(true);
    expect(result.sent).to.have.lengthOf(2);
    expect(result.safeBatch).to.equal(null);
  });

  it("lists the treasury by name even when it is the token's owner", async function () {
    const fixture = await loadRehearsal(deployRestrictedRehearsalFixture);
    const { escrow } = fixture.contracts;
    await (await escrow.setTreasury(fixture.deployer.address)).wait();

    await run(fixture);

    expect(await listed(fixture, fixture.deployer.address)).to.equal(true);
  });

  it("is idempotent: a second run sends nothing", async function () {
    const fixture = await loadRehearsal(deployRestrictedRehearsalFixture);
    await run(fixture);
    const nonce = await nonceOf(fixture.deployer);

    const result = await run(fixture);

    expect(result.sent).to.deep.equal([]);
    expect(await nonceOf(fixture.deployer)).to.equal(nonce);
    expect(fixture.lines.join("\n")).to.match(/already listed/);
  });

  it("lists only the one that is missing", async function () {
    const fixture = await loadRehearsal(deployRestrictedRehearsalFixture);
    await (await fixture.token.setTransferExempt(fixture.treasury.address, true)).wait();

    const result = await run(fixture);

    expect(result.sent).to.have.lengthOf(1);
    expect(await listed(fixture, await fixture.contracts.escrow.getAddress())).to.equal(true);
  });

  describe("--check", function () {
    it("passes when both are listed, sending nothing", async function () {
      const fixture = await loadRehearsal(deployRestrictedRehearsalFixture);
      await run(fixture);
      const nonce = await nonceOf(fixture.deployer);

      const result = await run(fixture, { check: true });

      expect(result.listed).to.deep.equal({ escrow: true, treasury: true });
      expect(await nonceOf(fixture.deployer)).to.equal(nonce);
    });

    for (const unlisted of ["escrow", "treasury"]) {
      it(`fails when the ${unlisted} is not listed, naming it, and sends nothing`, async function () {
        const fixture = await loadRehearsal(deployRestrictedRehearsalFixture);
        const other =
          unlisted === "escrow"
            ? fixture.treasury.address
            : await fixture.contracts.escrow.getAddress();
        await (await fixture.token.setTransferExempt(other, true)).wait();
        const nonce = await nonceOf(fixture.deployer);

        await expect(run(fixture, { check: true })).to.be.rejectedWith(
          new RegExp(`The ${unlisted} 0x[0-9a-fA-F]{40} is not listed`),
        );
        expect(await nonceOf(fixture.deployer)).to.equal(nonce);
      });
    }
  });

  it("prints Safe Transaction Builder JSON and sends nothing when the signer is not the token's owner", async function () {
    const fixture = await loadRehearsal(deployRestrictedRehearsalFixture);
    const { token, deployer, stranger, treasury } = fixture;
    const escrow = await fixture.contracts.escrow.getAddress();
    // The token's ownership moves in two steps, as the Safe would take it.
    await (await token.transferOwnership(stranger.address)).wait();
    await (await token.connect(stranger).acceptOwnership()).wait();
    const nonce = await nonceOf(deployer);

    const result = await run(fixture);

    expect(await nonceOf(deployer)).to.equal(nonce);
    expect(await listed(fixture, escrow)).to.equal(false);
    const batch = result.safeBatch;
    expect(batch.chainId).to.equal("31337");
    expect(batch.meta.createdFromSafeAddress).to.equal(stranger.address);
    const iface = token.interface;
    const tokenAddress = await token.getAddress();
    expect(batch.transactions).to.deep.equal(
      [escrow, treasury.address].map((account) => ({
        to: tokenAddress,
        value: "0",
        data: iface.encodeFunctionData("setTransferExempt", [account, true]),
        contractMethod: null,
        contractInputsValues: null,
      })),
    );
    // The printed JSON is the same batch, whole, so it can be saved and loaded in the builder.
    const printed = fixture.lines.find((line) => line.trim().startsWith("{"));
    expect(JSON.parse(printed)).to.deep.equal(batch);
  });

  it("refuses when the escrow pays in another token, sending nothing", async function () {
    const fixture = await loadRehearsal(deployRestrictedRehearsalFixture);
    const nonce = await nonceOf(fixture.deployer);

    await expect(run(fixture, { tokenAddress: fixture.stranger.address })).to.be.rejectedWith(
      /escrow\.ableToken\(\) is 0x[0-9a-fA-F]{40}, not TOKEN_CONTRACT_ADDRESS/,
    );
    expect(await nonceOf(fixture.deployer)).to.equal(nonce);
  });

  it("says a token that keeps no list needs no listing, and passes --check", async function () {
    const fixture = await loadRehearsal(deployRehearsalFixture);

    const result = await run(fixture, { check: true });

    expect(result.restricted).to.equal(false);
    expect(fixture.lines.join("\n")).to.match(/does not restrict who it moves between/);
  });

  it(`refuses to send on Base mainnet unless DEPLOY_MAINNET_CONFIRMED is exactly "1"`, async function () {
    const fixture = await loadRehearsal(deployRestrictedRehearsalFixture);

    await expect(
      run(fixture, { networkName: "base", env: { DEPLOY_MAINNET_CONFIRMED: "true" } }),
    ).to.be.rejectedWith(/DEPLOY_MAINNET_CONFIRMED=1/);
    expect(await listed(fixture, fixture.treasury.address)).to.equal(false);
  });

  it("calls the token only by functions the SENSE token declares", async function () {
    const sense = new ethers.Interface((await artifacts.readArtifact("SenseToken")).abi);
    for (const fragment of new ethers.Interface(TOKEN_ABI).fragments) {
      const declared = sense.getFunction(fragment.format("sighash"));
      expect(declared, fragment.format("sighash")).to.not.equal(null);
      expect(declared.format("full")).to.equal(fragment.format("full"));
    }
  });
});
