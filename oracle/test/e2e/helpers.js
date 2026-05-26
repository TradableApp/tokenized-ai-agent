const sinon = require("sinon");
const crypto = require("crypto");
const { ethers } = require("ethers");
const proxyquire = require("proxyquire").noCallThru();

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
      json: () => Promise.resolve({ message: { content: "Mocked AI Response" } }),
      text: () => Promise.resolve("Mocked AI Response"),
    }),
    "fs/promises": {
      writeFile: sinon.stub().resolves(),
      readFile: sinon.stub().rejects(new Error("File not found")),
    },
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

function setupOracleTestEnv(sessionKey) {
  const randomWallet = ethers.Wallet.createRandom();
  process.env.PRIVATE_KEY = randomWallet.privateKey;
  process.env.OLLAMA_URL = "http://fake-ollama";

  const mockedOracleComponents = createMockedOracleComponents();
  const stubs = createStubs(sessionKey);
  stubs["./contractUtility"].initializeOracle.returns(mockedOracleComponents);

  sinon.stub(global, "setInterval");

  const aiAgentOracle = proxyquire("../../src/aiAgentOracle", stubs);
  aiAgentOracle.initForTest(mockedOracleComponents);
  sinon.stub(global, "fetch").callsFake((...args) => stubs["node-fetch"](...args));
  delete process.env.CHAIN_GPT_API_KEY;

  return { aiAgentOracle, stubs, mockedOracleComponents };
}

function cleanupOracleTestEnv() {
  sinon.restore();
  delete process.env.AI_PROVIDER;
  delete process.env.PRIVATE_KEY;
  delete process.env.OLLAMA_URL;
  delete process.env.CHAIN_GPT_API_KEY;
  delete process.env.EVENT_BATCH_SIZE;
}

function makeFakeEvent(blockNumber, extras = {}) {
  return {
    blockNumber,
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
};
