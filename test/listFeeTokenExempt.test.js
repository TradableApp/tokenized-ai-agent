const { expect } = require("chai");
const { ethers, artifacts } = require("hardhat");

const {
  listFeeTokenExempt,
  resolveListingTarget,
  targetLines,
  TOKEN_ABI,
  LISTED_TRANSFER_SYMBOLS,
} = require("../scripts/list-fee-token-exempt");
const {
  loadRehearsal,
  deployPair,
  deployRehearsalFixture,
  deployRestrictedRehearsalFixture,
} = require("./helpers/rehearsalFixture");

// Stand-ins for a token that answers the listing question wrongly (contracts/test/ListingProbeToken.sol).
const NEVER_LISTED = 0;
const REVERTS_WITH_REASON = 1;
const REVERTS_EMPTY = 2;
async function probeToken(symbol, answer) {
  const token = await (await ethers.getContractFactory("ListingProbeToken")).deploy(symbol, answer);
  await token.waitForDeployment();
  return { token, ...(await deployPair(token)) };
}
async function neverListsFixture() {
  return probeToken("SENSE", NEVER_LISTED);
}
async function revertsWithReasonFixture() {
  return probeToken("SENSE", REVERTS_WITH_REASON);
}
// A token that calls itself SENSE but answers as one with no list.
async function senseWithNoListFixture() {
  return probeToken("SENSE", REVERTS_EMPTY);
}

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
      expectedSymbol: undefined,
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

    const result = await run(fixture);

    expect(await listed(fixture, fixture.deployer.address)).to.equal(true);
    // The owner is exempt by being the owner, which reads the same as a by-name listing. The
    // listing must be sent anyway, or the treasury stops being exempt when ownership moves.
    expect(result.sent).to.have.lengthOf(2);
    const newOwner = (await ethers.getSigners())[7];
    await (await fixture.token.transferOwnership(newOwner.address)).wait();
    await (await fixture.token.connect(newOwner).acceptOwnership()).wait();
    expect(await fixture.token.owner()).to.equal(newOwner.address);
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

  describe("which token it is", function () {
    it("treats SENSE as the token that moves only between listed addresses", function () {
      expect([...LISTED_TRANSFER_SYMBOLS]).to.deep.equal(["SENSE"]);
    });

    for (const networkName of ["hardhat", "baseSepolia"]) {
      describe(`on ${networkName}`, function () {
        it("lists both on the SENSE token when SENSE is expected, naming the symbol", async function () {
          const fixture = await loadRehearsal(deployRestrictedRehearsalFixture);

          const result = await run(fixture, { networkName, expectedSymbol: "SENSE" });

          expect(result.sent).to.have.lengthOf(2);
          expect(fixture.lines.join("\n")).to.include('(symbol "SENSE")');
        });

        it("passes --check on a token with no list when its own symbol is expected, naming the symbol", async function () {
          const fixture = await loadRehearsal(deployRehearsalFixture);

          const result = await run(fixture, { networkName, check: true, expectedSymbol: "ABLE" });

          expect(result.restricted).to.equal(false);
          expect(fixture.lines.join("\n")).to.match(
            /0x[0-9a-fA-F]{40} \(symbol "ABLE"\) does not restrict who it moves between/,
          );
        });

        it("refuses a token whose symbol is not the one expected, sending nothing", async function () {
          const fixture = await loadRehearsal(deployRestrictedRehearsalFixture);
          const nonce = await nonceOf(fixture.deployer);

          await expect(run(fixture, { networkName, expectedSymbol: "ABLE" })).to.be.rejectedWith(
            /token\.symbol\(\) is "SENSE", which is not EXPECTED_FEE_TOKEN_SYMBOL[\s\S]*Nothing was sent/,
          );
          expect(await nonceOf(fixture.deployer)).to.equal(nonce);
        });

        for (const check of [false, true]) {
          it(`refuses a SENSE token that answers as one with no list (check=${check})`, async function () {
            const fixture = await loadRehearsal(senseWithNoListFixture);

            await expect(
              run(fixture, { networkName, check, expectedSymbol: "SENSE" }),
            ).to.be.rejectedWith(
              /answers as a token that keeps no list, but its symbol "SENSE"[\s\S]*Nothing was sent/,
            );
          });
        }
      });
    }

    it("refuses a SENSE token that answers as one with no list even when no symbol is expected", async function () {
      const fixture = await loadRehearsal(senseWithNoListFixture);

      await expect(run(fixture, { check: true })).to.be.rejectedWith(/keeps no list/);
    });

    it("needs EXPECTED_FEE_TOKEN_SYMBOL on a live network", async function () {
      const fixture = await loadRehearsal(deployRehearsalFixture);

      await expect(run(fixture, { networkName: "baseSepolia", check: true })).to.be.rejectedWith(
        /EXPECTED_FEE_TOKEN_SYMBOL must be set on baseSepolia/,
      );
    });
  });

  it("rethrows a revert with a reason, which is the token's own answer and not a missing function", async function () {
    const fixture = await loadRehearsal(revertsWithReasonFixture);
    const nonce = await nonceOf(fixture.deployer);

    await expect(run(fixture)).to.be.rejectedWith(/listing unavailable/);
    expect(await nonceOf(fixture.deployer)).to.equal(nonce);
  });

  it("fails when an address still reads as not listed after it was listed", async function () {
    const fixture = await loadRehearsal(neverListsFixture);

    await expect(run(fixture)).to.be.rejectedWith(
      /After listing, the escrow 0x[0-9a-fA-F]{40} and the treasury 0x[0-9a-fA-F]{40} still reads? as not listed/,
    );
  });

  it(`refuses to send on Base mainnet unless DEPLOY_MAINNET_CONFIRMED is exactly "1"`, async function () {
    const fixture = await loadRehearsal(deployRestrictedRehearsalFixture);

    await expect(
      run(fixture, {
        networkName: "base",
        expectedSymbol: "SENSE",
        env: { DEPLOY_MAINNET_CONFIRMED: "true" },
      }),
    ).to.be.rejectedWith(/DEPLOY_MAINNET_CONFIRMED=1/);
    expect(await listed(fixture, fixture.treasury.address)).to.equal(false);
  });

  describe("the pair it acts on", function () {
    const envFile = ".env.base-testnet";
    const AGENT = "0x4a0C7e5807f9174499a8F56F2C69c61b39a4c64D";
    const ESCROW = "0x36ec08471F2b995024967204D7542713cFaf5Fa4";
    const TOKEN = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
    const file = {
      AI_AGENT_CONTRACT_ADDRESS: AGENT,
      AI_AGENT_ESCROW_CONTRACT_ADDRESS: ESCROW,
      TOKEN_CONTRACT_ADDRESS: TOKEN,
      EXPECTED_FEE_TOKEN_SYMBOL: "SENSE",
    };
    const outside = {
      AI_AGENT_CONTRACT_ADDRESS: "0x1111111111111111111111111111111111111111",
      AI_AGENT_ESCROW_CONTRACT_ADDRESS: "0x2222222222222222222222222222222222222222",
      TOKEN_CONTRACT_ADDRESS: "0x3333333333333333333333333333333333333333",
      EXPECTED_FEE_TOKEN_SYMBOL: "ROOTSYMBOL",
    };

    it("is read from ENV_FILE on a live network", function () {
      expect(
        resolveListingTarget({ networkName: "base", envFile, fileEnv: file, processEnv: file }),
      ).to.deep.equal({ agent: AGENT, escrow: ESCROW, token: TOKEN, expectedSymbol: "SENSE" });
    });

    for (const name of Object.keys(outside)) {
      it(`refuses ${name} set only in the root .env or the shell on a live network, never printing it`, function () {
        for (const networkName of ["baseSepolia", "base"]) {
          const fileEnv = { ...file };
          delete fileEnv[name];
          expect(() =>
            resolveListingTarget({
              networkName,
              envFile,
              fileEnv,
              processEnv: { ...fileEnv, [name]: outside[name] },
            }),
          )
            .to.throw(Error)
            .with.property("message")
            .that.includes(`${name} is not set in ${envFile}`)
            .and.includes("Nothing was sent")
            .and.not.includes(outside[name]);
        }
      });
    }

    it("refuses a live network with no ENV_FILE", function () {
      expect(() =>
        resolveListingTarget({
          networkName: "base",
          envFile: undefined,
          fileEnv: null,
          processEnv: file,
        }),
      ).to.throw(/ENV_FILE is not set/);
    });

    it("on a local network takes the merged environment, as the e2e bring-up runs it", function () {
      const processEnv = {
        AI_AGENT_ESCROW_CONTRACT_ADDRESS: ESCROW,
        TOKEN_CONTRACT_ADDRESS: TOKEN,
      };
      expect(
        resolveListingTarget({
          networkName: "localnet",
          envFile: ".env.base-localnet",
          fileEnv: {},
          processEnv,
        }),
      ).to.deep.equal({ agent: null, escrow: ESCROW, token: TOKEN, expectedSymbol: null });
    });

    it("prints the network, the agent, the escrow and the token before anything is read", function () {
      const text = targetLines({
        networkName: "base",
        envFile,
        check: true,
        signer: AGENT,
        target: { agent: AGENT, escrow: ESCROW, token: TOKEN, expectedSymbol: "SENSE" },
      }).join("\n");
      expect(text).to.include("on base");
      expect(text).to.include(`Agent: ${AGENT}`);
      expect(text).to.include(`Escrow: ${ESCROW}`);
      expect(text).to.include(`Fee token: ${TOKEN} (expected symbol SENSE)`);
      expect(text).to.include(envFile);
    });
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
