const { expect } = require("chai");
const { ethers } = require("ethers");
const sinon = require("sinon");
const path = require("path");

const { createDecryptor } = require("../src/oracleKeys");
const {
  CHECK_EVERY_MS,
  RECEIPT_TIMEOUT_MS,
  REMIND_EVERY_MS,
  createKeyPublisher,
} = require("../src/encryptionKeyPublisher");

// The agent's compiled ABI, so the names this module decodes are the contract's own.
const AGENT_ABI = require(
  path.join(__dirname, "../../artifacts/contracts/EVMAIAgent.sol/EVMAIAgent.json"),
).abi;
const AGENT_INTERFACE = new ethers.Interface(AGENT_ABI);

const CHAIN_ID = 84532n;
const AGENT = "0x1111111111111111111111111111111111111111";
const ORACLE = "0x2222222222222222222222222222222222222222";
const OTHER_ORACLE = "0x3333333333333333333333333333333333333333";
const NOT_PUBLISHED = "CRITICAL: Oracle Encryption Key Not Published";
const RESOLVED = "RESOLVED: Oracle encryption key is published";

/** The revert an agent gives, as ethers reports a revert caught at gas estimation. */
function revertWith(errorName, args = []) {
  return Object.assign(new Error("execution reverted"), {
    code: "CALL_EXCEPTION",
    data: AGENT_INTERFACE.encodeErrorResult(errorName, args),
  });
}

describe("encryptionKeyPublisher", () => {
  let decryptor;
  let contract;
  let alert;
  let report;
  let onRoleRefused;
  let roleLost;
  let clock;
  let insideMutex;
  let mutexCalls;

  function publisher(overrides = {}) {
    return createKeyPublisher({
      contract,
      signerAddress: ORACLE,
      decryptor,
      chainId: CHAIN_ID,
      runExclusive: async (work) => {
        mutexCalls += 1;
        insideMutex = true;
        try {
          return await work();
        } finally {
          insideMutex = false;
        }
      },
      isRoleLost: () => roleLost,
      onRoleRefused,
      alert,
      report,
      log: { log() {}, warn() {}, error() {} },
      now: () => clock,
      ...overrides,
    });
  }

  const alertsTitled = (title) => alert.getCalls().filter((call) => call.args[0] === title);

  beforeEach(() => {
    decryptor = createDecryptor(ethers.getBytes(ethers.Wallet.createRandom().privateKey));
    clock = 1_000_000;
    roleLost = false;
    insideMutex = false;
    mutexCalls = 0;
    alert = sinon.stub().resolves();
    report = sinon.stub();
    onRoleRefused = sinon.stub().resolves(false);
    contract = {
      target: AGENT,
      interface: AGENT_INTERFACE,
      // No key published yet: the getter returns empty bytes and the publisher is zero.
      oracleEncryptionKey: sinon.stub().resolves("0x"),
      oracleEncryptionKeyPublisher: sinon.stub().resolves(ethers.ZeroAddress),
      setOracleEncryptionKey: sinon.stub().callsFake(async () => {
        expect(insideMutex, "the transaction is sent under the transaction lock").to.equal(true);
        return { hash: "0xpublish", wait: sinon.stub().resolves({ status: 1, hash: "0xpublish" }) };
      }),
    };
  });

  it("uses the names the agent's ABI declares", () => {
    expect(AGENT_INTERFACE.getFunction("setOracleEncryptionKey").format()).to.equal(
      "setOracleEncryptionKey(bytes,bytes)",
    );
    expect(AGENT_INTERFACE.getFunction("oracleEncryptionKey").format()).to.equal(
      "oracleEncryptionKey()",
    );
    expect(AGENT_INTERFACE.getFunction("oracleEncryptionKeyPublisher").format()).to.equal(
      "oracleEncryptionKeyPublisher()",
    );
    expect(AGENT_INTERFACE.getError("EncryptionKeyHeldByAnotherOracle").format()).to.equal(
      "EncryptionKeyHeldByAnotherOracle(address)",
    );
    expect(AGENT_INTERFACE.getError("UnauthorizedOracle").format()).to.equal(
      "UnauthorizedOracle()",
    );
  });

  it("sends nothing when the chain already shows its key, in any letter case", async () => {
    contract.oracleEncryptionKey.resolves(decryptor.publicKey.toUpperCase().replace("0X", "0x"));

    const outcome = await publisher().check();

    expect(outcome).to.equal("unchanged");
    sinon.assert.notCalled(contract.setOracleEncryptionKey);
    sinon.assert.notCalled(alert);
  });

  it("publishes its key with a proof the agent accepts, and reads the receipt's status", async () => {
    const outcome = await publisher().check();

    expect(outcome).to.equal("published");
    sinon.assert.calledOnce(contract.setOracleEncryptionKey);
    const [key, proof] = contract.setOracleEncryptionKey.firstCall.args;
    expect(key).to.equal(decryptor.publicKey);
    // The statement the agent checks: (domain, chain id, agent, sender, keccak256(key)), signed
    // as an EIP-191 personal message by the key itself.
    const statement = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "uint256", "address", "address", "bytes32"],
        ["SenseAI oracle encryption key v1", CHAIN_ID, AGENT, ORACLE, ethers.keccak256(key)],
      ),
    );
    expect(ethers.verifyMessage(ethers.getBytes(statement), proof)).to.equal(
      ethers.computeAddress(key),
    );
    const { wait } = await contract.setOracleEncryptionKey.firstCall.returnValue;
    sinon.assert.calledOnceWithExactly(wait, 1, RECEIPT_TIMEOUT_MS);
    expect(mutexCalls).to.equal(1);
    sinon.assert.notCalled(alert);
  });

  it("does not count a receipt whose status is not 1 as published", async () => {
    contract.setOracleEncryptionKey.resolves({
      hash: "0xpublish",
      wait: sinon.stub().resolves({ status: 0, hash: "0xpublish" }),
    });

    const outcome = await publisher().check();

    expect(outcome).to.equal("failed");
    expect(alertsTitled(NOT_PUBLISHED)).to.have.lengthOf(1);
  });

  /** What ethers 6 throws from wait() for a mined transaction that reverted: no revert data. */
  function minedRevert() {
    return Object.assign(new Error("transaction execution reverted"), {
      code: "CALL_EXCEPTION",
      receipt: { status: 0, hash: "0xpublish" },
    });
  }

  it("names a mined revert as one, when the oracle still holds its role", async () => {
    contract.setOracleEncryptionKey.resolves({
      hash: "0xpublish",
      wait: sinon.stub().rejects(minedRevert()),
    });
    onRoleRefused.resolves(false);

    const outcome = await publisher().check();

    expect(outcome).to.equal("failed");
    sinon.assert.calledOnceWithExactly(report, "reverted");
    expect(alertsTitled(NOT_PUBLISHED)).to.have.lengthOf(1);
  });

  it("says who holds the key when another oracle published first and this send reverted", async () => {
    // Both oracles read an empty slot; the other one's send was mined first.
    contract.oracleEncryptionKeyPublisher
      .onFirstCall()
      .resolves(ethers.ZeroAddress)
      .onSecondCall()
      .resolves(OTHER_ORACLE);
    contract.setOracleEncryptionKey.resolves({
      hash: "0xpublish",
      wait: sinon.stub().rejects(minedRevert()),
    });
    onRoleRefused.resolves(false);

    const outcome = await publisher().check();

    expect(outcome).to.equal("held-by-other");
    const [page] = alertsTitled(NOT_PUBLISHED);
    expect(page.args[1]).to.include(`removeOracle(${OTHER_ORACLE})`);
  });

  it("alerts when the receipt does not come, and leaves the transaction lock free", async () => {
    const timeout = Object.assign(new Error("wait for transaction timeout"), { code: "TIMEOUT" });
    contract.setOracleEncryptionKey.resolves({
      hash: "0xpublish",
      wait: sinon.stub().rejects(timeout),
    });

    const outcome = await publisher().check();

    expect(outcome).to.equal("failed");
    expect(alertsTitled(NOT_PUBLISHED)).to.have.lengthOf(1);
    expect(insideMutex, "the lock is released").to.equal(false);
  });

  it("reads and sends nothing while the oracle role is believed lost", async () => {
    roleLost = true;

    const outcome = await publisher().check();

    expect(outcome).to.equal("role-missing");
    sinon.assert.notCalled(contract.oracleEncryptionKey);
    sinon.assert.notCalled(contract.setOracleEncryptionKey);
    sinon.assert.notCalled(alert);
  });

  it("sends nothing when another oracle holds the key, and names it and the remedy", async () => {
    contract.oracleEncryptionKey.resolves(`0x04${"ab".repeat(64)}`);
    contract.oracleEncryptionKeyPublisher.resolves(OTHER_ORACLE);

    const outcome = await publisher().check();

    expect(outcome).to.equal("held-by-other");
    sinon.assert.notCalled(contract.setOracleEncryptionKey);
    const [held] = alertsTitled(NOT_PUBLISHED);
    expect(held.args[1]).to.include(OTHER_ORACLE);
    expect(held.args[1]).to.include(`removeOracle(${OTHER_ORACLE})`);
    sinon.assert.calledOnce(report);
    expect(report.firstCall.args[0]).to.equal("held-by-other");
  });

  it("publishes over its own earlier key", async () => {
    contract.oracleEncryptionKey.resolves(`0x04${"ab".repeat(64)}`);
    contract.oracleEncryptionKeyPublisher.resolves(ORACLE.toUpperCase().replace("0X", "0x"));

    expect(await publisher().check()).to.equal("published");
  });

  it("takes the agent's own refusal for another oracle's key the same way", async () => {
    contract.setOracleEncryptionKey.rejects(
      revertWith("EncryptionKeyHeldByAnotherOracle", [OTHER_ORACLE]),
    );

    const outcome = await publisher().check();

    expect(outcome).to.equal("held-by-other");
    expect(alertsTitled(NOT_PUBLISHED)[0].args[1]).to.include(`removeOracle(${OTHER_ORACLE})`);
  });

  it("hands a refusal for want of the role to the role gate and pages nothing itself", async () => {
    onRoleRefused.resolves(true);
    const refusal = revertWith("UnauthorizedOracle");
    contract.setOracleEncryptionKey.rejects(refusal);

    const outcome = await publisher().check();

    expect(outcome).to.equal("role-missing");
    sinon.assert.calledOnceWithExactly(onRoleRefused, refusal);
    sinon.assert.notCalled(alert);
  });

  it("alerts with no request address or key, once an hour while it lasts, then resolves", async () => {
    const rpcFailure = () =>
      Object.assign(
        new Error("request failed: https://base-sepolia.example.org/v2/sEcReTkEy123456789 timeout"),
        { code: "SERVER_ERROR" },
      );
    contract.oracleEncryptionKey.rejects(rpcFailure());
    const keyPublisher = publisher();

    expect(await keyPublisher.check()).to.equal("failed");
    const [first] = alertsTitled(NOT_PUBLISHED);
    expect(first.args[1]).to.not.include("sEcReTkEy123456789");
    expect(first.args[1]).to.not.include("base-sepolia.example.org/v2");

    // Five minutes later, the same failure: logged, not paged again.
    clock += CHECK_EVERY_MS;
    await keyPublisher.check();
    expect(alertsTitled(NOT_PUBLISHED)).to.have.lengthOf(1);

    // An hour after the first page: a reminder.
    clock += REMIND_EVERY_MS;
    await keyPublisher.check();
    expect(alertsTitled(NOT_PUBLISHED)).to.have.lengthOf(2);
    expect(report.callCount, "one report per page").to.equal(2);

    // The chain answers again and shows no key: published, and the page is resolved.
    contract.oracleEncryptionKey.resolves("0x");
    clock += CHECK_EVERY_MS;
    expect(await keyPublisher.check()).to.equal("published");
    expect(alertsTitled(RESOLVED)).to.have.lengthOf(1);

    // Nothing more to resolve after that.
    contract.oracleEncryptionKey.resolves(decryptor.publicKey);
    await keyPublisher.check();
    expect(alertsTitled(RESOLVED)).to.have.lengthOf(1);
  });

  it("pages again at once when the failure changes kind", async () => {
    contract.oracleEncryptionKey.rejects(
      Object.assign(new Error("down"), { code: "SERVER_ERROR" }),
    );
    const keyPublisher = publisher();
    await keyPublisher.check();

    contract.oracleEncryptionKey.resolves(`0x04${"ab".repeat(64)}`);
    contract.oracleEncryptionKeyPublisher.resolves(OTHER_ORACLE);
    await keyPublisher.check();

    expect(alertsTitled(NOT_PUBLISHED)).to.have.lengthOf(2);
  });

  it("runs one check at a time: a second call while one runs shares it", async () => {
    let release;
    contract.oracleEncryptionKey.returns(
      new Promise((resolve) => {
        release = () => resolve("0x");
      }),
    );
    const keyPublisher = publisher();

    const first = keyPublisher.check();
    const second = keyPublisher.check();
    release();

    expect(await first).to.equal("published");
    expect(await second).to.equal("published");
    sinon.assert.calledOnce(contract.setOracleEncryptionKey);
  });

  it("never throws, even when the alert itself throws", async () => {
    contract.oracleEncryptionKey.rejects(new Error("down"));
    alert = sinon.stub().throws(new Error("slack is down"));
    report = sinon.stub().throws(new Error("sentry is down"));

    expect(await publisher().check()).to.equal("failed");
  });

  it("watch() checks again every five minutes on a timer that does not hold the process", async () => {
    const unref = sinon.stub();
    const setIntervalFn = sinon.stub().returns({ unref });
    const keyPublisher = publisher();

    keyPublisher.watch({ setIntervalFn });

    sinon.assert.calledOnce(setIntervalFn);
    // 5 minutes = 5 * 60 * 1000 ms. A check that finds the key on chain is one eth_call.
    expect(setIntervalFn.firstCall.args[1]).to.equal(5 * 60 * 1000);
    sinon.assert.calledOnce(unref);
    setIntervalFn.firstCall.args[0]();
    await new Promise((resolve) => setImmediate(resolve));
    sinon.assert.calledOnce(contract.oracleEncryptionKey);
  });
});
