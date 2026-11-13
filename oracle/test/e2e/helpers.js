const sinon = require("sinon");
const crypto = require("crypto");
const { ethers } = require("ethers");
const proxyquire = require("proxyquire").noCallThru();
const realStateStore = require("../../src/oracleState/store");
const realStateRuntime = require("../../src/oracleState/runtime");
const { createTempStateStore, txHash } = require("../helpers/tempStateStore");

function createEncryptedString(dataObject, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.from(JSON.stringify(dataObject));
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  const combined = Buffer.concat([encrypted, tag]);
  return `${iv.toString("base64")}.${combined.toString("base64")}`;
}

function createMockedOracleComponents() {
  return {
    provider: {
      getNetwork: sinon.stub().resolves({ chainId: 1 }),
      getTransactionReceipt: sinon.stub(),
      getBlock: sinon.stub().resolves({ timestamp: Math.floor(Date.now() / 1000) }),
      getBlockNumber: sinon.stub().resolves(10000),
    },
    signer: { address: "0xOracleAddress" },
    contract: {
      target: "0xMockedContractAddress",
      submitAnswer: sinon
        .stub()
        .resolves({ wait: () => Promise.resolve({ hash: "0xTxHash" }) }),
      submitBranch: sinon
        .stub()
        .resolves({ wait: () => Promise.resolve({ hash: "0xTxHash" }) }),
      submitConversationMetadata: sinon
        .stub()
        .resolves({ wait: () => Promise.resolve({ hash: "0xTxHash" }) }),
      isJobFinalized: sinon.stub().resolves(false),
      oracle: sinon.stub(),
      setOracle: sinon.stub().resolves({ wait: () => Promise.resolve() }),
      queryFilter: sinon.stub(),
      on: sinon.stub(),
      filters: {
        PromptSubmitted: sinon.stub(),
        RegenerationRequested: sinon.stub(),
        BranchRequested: sinon.stub(),
        MetadataUpdateRequested: sinon.stub(),
      },
      interface: {
        parseLog: sinon.stub(),
      },
    },
    isSapphire: false,
  };
}

function createStubs(sessionKey) {
  const encryptedKey = Buffer.from("fake-ecies-cipher-blob");

  return {
    "./storage/storage": {
      initializeStorage: sinon.stub().resolves(),
      uploadData: sinon.stub().callsFake((buffer) => {
        const hash = crypto.createHash("sha256").update(buffer).digest("hex");
        return Promise.resolve(`fake_cid_${hash.substring(0, 10)}`);
      }),
      fetchData: sinon.stub().resolves(createEncryptedString({}, sessionKey)),
      queryTransactionByTags: sinon.stub().resolves(null),
    },
    "./contractUtility": {
      initializeOracle: sinon.stub(),
    },
    "./roflUtility": {
      submitTx: sinon.stub().resolves("0xRoflTxHash"),
    },
    "./alerting": {
      sendAlert: sinon.stub().resolves(),
    },
    "node-fetch": sinon.stub().resolves({
      ok: true,
      // Generic "any AI provider answered" body: ChainGPT-style `message.content` plus Gemini's
      // `candidates` shape, so routing and the direct fallback tier resolve like the other tiers.
      json: () =>
        Promise.resolve({
          message: { content: "Mocked AI Response" },
          candidates: [{ content: { parts: [{ text: "Mocked AI Response" }] } }],
        }),
      text: () => Promise.resolve("Mocked AI Response"),
    }),
    "./ecies": {
      eciesDecrypt: sinon.stub().resolves(sessionKey),
      eciesEncrypt: sinon.stub().resolves(encryptedKey),
      publicKeyFromPrivateKey: sinon.stub().returns("04" + "0f".repeat(64)),
    },
    "@elizaos/core": {
      ElizaOS: class {
        async addAgents() {
          return ["fake-agent-id"];
        }
        async startAgents() {}
        getAgent() {
          return null;
        }
      },
      elizaLogger: {
        info: () => {},
        log: () => {},
        error: () => {},
        warn: () => {},
        debug: () => {},
      },
      stringToUuid: (s) => s,
      createUniqueUuid: (_ns, s) => s,
      ChannelType: { DM: "DM", WORLD: "WORLD" },
    },
    "./elizaos/plugins/plugin-senseai/dist/index.js": { default: {} },
    "./elizaos/character.js": {},
    "@sentry/node": {
      init: sinon.stub(),
      captureException: sinon.stub(),
      captureMessage: sinon.stub(),
      withScope: sinon.stub(),
      configureScope: sinon.stub(),
      setTag: sinon.stub(),
      setUser: sinon.stub(),
      startSpan: sinon.stub().callsFake((_opts, fn) => fn && fn({})),
      getCurrentScope: sinon
        .stub()
        .returns({ setTag: sinon.stub(), setUser: sinon.stub() }),
    },
    "./formatters": {
      createConversationFile: sinon.stub().callsFake((data) => data),
      createConversationMetadataFile: sinon.stub().callsFake((data) => data),
      createMessageFile: sinon.stub().callsFake((data) => data),
      createSearchIndexDeltaFile: sinon.stub().callsFake((data) => data),
      generateKeywords: sinon.stub().returns([]),
    },
  };
}

/** Captured so cleanup can restore rather than delete — see cleanupOracleTestEnv. */
let originalAgentAddress;

/** This test's state store; its temp directory is removed by cleanupOracleTestEnv. */
let activeTempStore = null;

/**
 * @param {Buffer} sessionKey
 * @param {{ now?: () => Date }} [options] `now` is the state store's clock, for tests that
 *   assert when a failed job next becomes due
 */
function setupOracleTestEnv(sessionKey, { now } = {}) {
  const randomWallet = ethers.Wallet.createRandom();
  process.env.PRIVATE_KEY = randomWallet.privateKey;
  // .env.oracle.example ships "0xYourAIAgentAddressHere" and start()'s config guard rejects it
  // deliberately — ethers accepts a placeholder and fails much later as an unrelated-looking
  // ENS error. The example keeps the placeholder so the guard is useful to a new developer; the
  // fixture supplies a well-formed address instead.
  originalAgentAddress = process.env.AI_AGENT_CONTRACT_ADDRESS;
  process.env.AI_AGENT_CONTRACT_ADDRESS = randomWallet.address;

  const mockedOracleComponents = createMockedOracleComponents();
  const stubs = createStubs(sessionKey);
  stubs["./contractUtility"].initializeOracle.returns(mockedOracleComponents);

  // Each test gets its own real file store in a temp directory. The oracle points two stores at
  // oracle/oracle-state.json: its module-level default, and the one start() builds through
  // createStateStore. Both are redirected — the runtime stub keeps the real backend selection
  // but swaps in the temp paths — so a restart in a test reads back what the previous start
  // wrote, and nothing lands in the repo.
  activeTempStore = createTempStateStore({ now });
  const { statePath, jobsPath } = activeTempStore;
  const tempStore = activeTempStore.store;
  stubs["./oracleState/store"] = { ...realStateStore, createFileStateStore: () => tempStore };
  stubs["./oracleState/runtime"] = {
    ...realStateRuntime,
    createStateStore: sinon.spy((options) =>
      realStateRuntime.createStateStore({ ...options, statePath, jobsPath }),
    ),
  };

  sinon.stub(global, "setInterval");

  const aiAgentOracle = proxyquire("../../src/aiAgentOracle", stubs);
  aiAgentOracle.initForTest({ ...mockedOracleComponents, stateStore: tempStore });
  sinon.stub(global, "fetch").callsFake((...args) => stubs["node-fetch"](...args));
  delete process.env.CHAIN_GPT_API_KEY;

  return {
    aiAgentOracle,
    stubs,
    mockedOracleComponents,
    stateStore: tempStore,
    stateFiles: { statePath, jobsPath },
  };
}

function cleanupOracleTestEnv() {
  sinon.restore();
  delete process.env.AI_PROVIDER;
  delete process.env.PRIVATE_KEY;
  // RESTORED, not deleted. contractUtility.initializeOracle reads this at MODULE LOAD, so
  // clearing it starves any later suite that requires aiAgentOracle fresh (proxyquire does,
  // per file) with "Missing required env variable" — a failure in a completely unrelated test.
  if (originalAgentAddress === undefined) delete process.env.AI_AGENT_CONTRACT_ADDRESS;
  else process.env.AI_AGENT_CONTRACT_ADDRESS = originalAgentAddress;
  delete process.env.CHAIN_GPT_API_KEY;
  delete process.env.EVENT_BATCH_SIZE;
  if (activeTempStore) {
    activeTempStore.cleanup();
    activeTempStore = null;
  }
}

/**
 * An event shaped like the ones ethers hands the poll loop. The transaction hash and log index
 * are what the failed-job queue stores, so they must be realistic: a 0x + 64-hex hash (derived
 * from the block, so distinct events get distinct hashes) and an `index`. Overrides win.
 */
function makeFakeEvent(blockNumber, extras = {}) {
  return {
    blockNumber,
    transactionHash: txHash(`block-${blockNumber}`),
    index: 0,
    getBlock: () => Promise.resolve({ timestamp: Math.floor(Date.now() / 1000) }),
    ...extras,
  };
}

module.exports = {
  createEncryptedString,
  createMockedOracleComponents,
  createStubs,
  setupOracleTestEnv,
  cleanupOracleTestEnv,
  makeFakeEvent,
  txHash,
};
