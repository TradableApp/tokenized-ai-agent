"use strict";

// STORAGE_PROVIDER=autonomys-only: a deployment that writes every file to Autonomys and has never
// written to Irys/Arweave. Irys is never started or funded, tag lookups ask Autonomys alone, and
// an Arweave-shaped id is not an id this deployment produces, so it is neither fetched nor taken
// from a payload.

const { expect } = require("chai");
const sinon = require("sinon");
const proxyquire = require("proxyquire");

const { isBadInputError } = require("../src/errors");

const AUTONOMYS_ID = `bafkr6i${"a".repeat(52)}`;
const ARWEAVE_43 = "Ab0_-".repeat(9).slice(0, 43);
const ARWEAVE_44 = "Ab0_-".repeat(9).slice(0, 44);

function withEnv(overrides) {
  const saved = {};
  for (const [name, value] of Object.entries(overrides)) {
    saved[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  return () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

describe("storage mode setting", () => {
  let storageMode;
  let SUPPORTED_STORAGE_PROVIDERS;

  before(() => {
    ({ storageMode, SUPPORTED_STORAGE_PROVIDERS } = require("../src/storage/storageMode"));
  });

  it("reads unset and empty as Irys and Autonomys, as before", () => {
    expect(storageMode({})).to.equal("irys-and-autonomys");
    expect(storageMode({ STORAGE_PROVIDER: "" })).to.equal("irys-and-autonomys");
    expect(storageMode({ STORAGE_PROVIDER: "   " })).to.equal("irys-and-autonomys");
  });

  it("reads irys as Irys only, as before", () => {
    expect(storageMode({ STORAGE_PROVIDER: "irys" })).to.equal("irys");
  });

  it("reads autonomys-only, trimmed and in any case", () => {
    expect(storageMode({ STORAGE_PROVIDER: "autonomys-only" })).to.equal("autonomys-only");
    expect(storageMode({ STORAGE_PROVIDER: " Autonomys-Only " })).to.equal("autonomys-only");
  });

  it("gives null for any other value", () => {
    for (const value of ["autonomys", "iris", "arweave", "autonomys_only", "both"]) {
      expect(storageMode({ STORAGE_PROVIDER: value }), value).to.equal(null);
    }
  });

  it("lists the names an operator can set", () => {
    expect(SUPPORTED_STORAGE_PROVIDERS).to.deep.equal(["irys", "autonomys-only"]);
  });
});

describe("content ids in autonomys-only mode", () => {
  const { contentIdKind, isContentId, printableContentId } = require("../src/storage/contentId");
  const env = { STORAGE_PROVIDER: "autonomys-only" };

  it("takes an Autonomys id", () => {
    expect(contentIdKind(AUTONOMYS_ID, env)).to.equal("autonomys");
  });

  it("does not take an Arweave-shaped id of 43 or 44 characters", () => {
    for (const id of [ARWEAVE_43, ARWEAVE_44]) {
      expect(contentIdKind(id, env), id).to.equal(null);
      expect(isContentId(id, env), id).to.equal(false);
      expect(printableContentId(id, env)).to.not.include(id);
    }
  });

  it("still takes an Arweave-shaped id without the mode", () => {
    expect(contentIdKind(ARWEAVE_43, {})).to.equal("arweave");
    expect(contentIdKind(ARWEAVE_43, { STORAGE_PROVIDER: "irys" })).to.equal("arweave");
  });
});

describe("payload content ids in autonomys-only mode", () => {
  const { validatePayload } = require("../src/payloadValidator");
  let restore;

  beforeEach(() => {
    restore = withEnv({
      STORAGE_PROVIDER: "autonomys-only",
      USE_MOCK_STORAGE: "false",
      LOCAL_IPFS_API_URL: undefined,
    });
  });

  afterEach(() => restore());

  function refusalOf(input, eventName) {
    try {
      validatePayload(input, eventName);
    } catch (error) {
      return error;
    }
    throw new Error("expected the payload to be refused");
  }

  it("refuses an Arweave-shaped parent id as the sender's bad input, without repeating it", () => {
    for (const id of [ARWEAVE_43, ARWEAVE_44]) {
      const error = refusalOf(
        { promptText: "hello", isNewConversation: false, previousMessageCID: id },
        "PromptSubmitted",
      );
      expect(isBadInputError(error), id).to.equal(true);
      expect(error.message).to.include("previousMessageCID");
      expect(error.message).to.not.include(id);
    }
  });

  it("refuses an Arweave-shaped id in a regeneration as bad input", () => {
    for (const field of ["promptMessageCID", "originalAnswerMessageCID"]) {
      const error = refusalOf(
        {
          instructions: "shorter",
          promptMessageCID: AUTONOMYS_ID,
          originalAnswerMessageCID: AUTONOMYS_ID,
          [field]: ARWEAVE_43,
        },
        "RegenerationRequested",
      );
      expect(isBadInputError(error), field).to.equal(true);
      expect(error.message).to.include(field);
    }
  });

  it("takes an Autonomys parent id", () => {
    const parsed = validatePayload(
      { promptText: "hello", isNewConversation: false, previousMessageCID: AUTONOMYS_ID },
      "PromptSubmitted",
    );
    expect(parsed.previousMessageCID).to.equal(AUTONOMYS_ID);
  });
});

describe("storage router — autonomys-only mode", () => {
  let storage;
  let arweaveStub;
  let autonomysStub;
  let mirrorStub;
  let restore;

  beforeEach(() => {
    restore = withEnv({
      STORAGE_PROVIDER: "autonomys-only",
      USE_MOCK_STORAGE: "false",
      LOCAL_IPFS_API_URL: undefined,
    });
    arweaveStub = {
      initializeIrys: sinon.stub().resolves(),
      uploadData: sinon.stub().resolves("arweave_cid_123"),
      fetchData: sinon.stub().resolves("arweave_data"),
      queryTransactionByTags: sinon.stub().resolves("arweave_tx_id"),
    };
    autonomysStub = {
      initializeAutoDrive: sinon.stub().resolves(),
      uploadData: sinon.stub().resolves(AUTONOMYS_ID),
      fetchData: sinon.stub().resolves("autonomys_data"),
      queryTransactionByTags: sinon.stub().resolves(null),
    };
    mirrorStub = { mirrorInBackground: sinon.stub().resolves() };
    storage = proxyquire("../src/storage/storage", {
      "./arweave": arweaveStub,
      "./autonomys": autonomysStub,
      "./mirror": mirrorStub,
    });
    sinon.stub(console, "log");
    sinon.stub(console, "warn");
  });

  afterEach(() => {
    sinon.restore();
    restore();
  });

  it("starts Auto Drive and never starts (or funds) Irys", async () => {
    await storage.initializeStorage();

    expect(autonomysStub.initializeAutoDrive.calledOnce).to.equal(true);
    expect(arweaveStub.initializeIrys.called).to.equal(false);
  });

  it("uploads to Autonomys and mirrors, as without the mode", async () => {
    const buffer = Buffer.from("ciphertext");
    const cid = await storage.uploadData(buffer, [{ name: "File-Name", value: "a.json" }]);

    expect(cid).to.equal(AUTONOMYS_ID);
    expect(autonomysStub.uploadData.calledOnce).to.equal(true);
    expect(arweaveStub.uploadData.called).to.equal(false);
    expect(mirrorStub.mirrorInBackground.calledOnceWith(AUTONOMYS_ID, buffer, "a.json")).to.equal(
      true,
    );
  });

  it("refuses an Arweave-shaped id before any provider is asked", async () => {
    for (const id of [ARWEAVE_43, ARWEAVE_44]) {
      let refused;
      try {
        await storage.fetchData(id);
      } catch (error) {
        refused = error;
      }
      expect(refused, id).to.be.an("error");
      expect(refused.message).to.include("Unsupported content id");
      expect(refused.message).to.not.include(id);
    }
    expect(arweaveStub.fetchData.called).to.equal(false);
    expect(autonomysStub.fetchData.called).to.equal(false);
  });

  it("fetches an Autonomys id from Auto Drive", async () => {
    expect(await storage.fetchData(AUTONOMYS_ID)).to.equal("autonomys_data");
    expect(autonomysStub.fetchData.calledOnce).to.equal(true);
  });

  it("asks Autonomys alone for a tag match, and gives null on a miss", async () => {
    const tags = [{ name: "SenseAI-Key-For-Conversation", value: "84532-7" }];

    expect(await storage.queryTransactionByTags(tags)).to.equal(null);
    expect(autonomysStub.queryTransactionByTags.calledOnceWith(tags)).to.equal(true);
    expect(arweaveStub.queryTransactionByTags.called).to.equal(false);
  });

  it("gives Autonomys's match", async () => {
    autonomysStub.queryTransactionByTags.resolves(AUTONOMYS_ID);

    expect(await storage.queryTransactionByTags([])).to.equal(AUTONOMYS_ID);
    expect(arweaveStub.queryTransactionByTags.called).to.equal(false);
  });

  it("gives null, without asking Irys, when the Autonomys query fails", async () => {
    autonomysStub.queryTransactionByTags.rejects(new Error("Service Unavailable"));

    expect(await storage.queryTransactionByTags([])).to.equal(null);
    expect(arweaveStub.queryTransactionByTags.called).to.equal(false);
  });
});

describe("start-up check — STORAGE_PROVIDER", () => {
  const { validateConfig } = require("../src/startupConfig");

  // A complete remote-storage configuration apart from what each case changes.
  function env(overrides) {
    return {
      NETWORK_NAME: "baseSepolia",
      AI_AGENT_CONTRACT_ADDRESS: "0x4a0C7e5807f9174499a8F56F2C69c61b39a4c64D",
      USE_MOCK_STORAGE: "false",
      POSTGRES_AGENT_DATABASE: "oracle_agent",
      POSTGRES_HOST: "10.0.0.5",
      POSTGRES_PORT: "5432",
      POSTGRES_DATABASE: "senseai",
      POSTGRES_USER: "senseai",
      POSTGRES_PASSWORD: "not-a-real-password",
      POSTGRES_CLIENT_CERT_PATH: "/certs/client.crt",
      POSTGRES_CLIENT_KEY_PATH: "/certs/client.key",
      POSTGRES_SERVER_CA_CERT_PATH: "/certs/ca.crt",
      COINGECKO_API_KEY: "not-a-real-key",
      AUTONOMYS_API_KEY: "a-real-looking-autonomys-key",
      IRYS_PAYMENT_PRIVATE_KEY: "0xabc",
      ...overrides,
    };
  }

  function problemsOf(config) {
    try {
      validateConfig(config);
    } catch (error) {
      return error.message;
    }
    return null;
  }

  it("starts in autonomys-only mode with no Irys key", () => {
    expect(
      problemsOf(env({ STORAGE_PROVIDER: "autonomys-only", IRYS_PAYMENT_PRIVATE_KEY: undefined })),
    ).to.equal(null);
  });

  it("asks for the Autonomys key in autonomys-only mode, and says the Irys key is not used", () => {
    const message = problemsOf(
      env({
        STORAGE_PROVIDER: "autonomys-only",
        AUTONOMYS_API_KEY: "",
        IRYS_PAYMENT_PRIVATE_KEY: undefined,
      }),
    );

    expect(message).to.include("AUTONOMYS_API_KEY is missing or empty");
    expect(message).to.include('STORAGE_PROVIDER is "autonomys-only"');
    expect(message).to.include("IRYS_PAYMENT_PRIVATE_KEY is not used");
    expect(message).to.not.match(/IRYS_PAYMENT_PRIVATE_KEY is missing/);
  });

  it("still asks for both keys when STORAGE_PROVIDER is unset", () => {
    const message = problemsOf(
      env({ STORAGE_PROVIDER: undefined, AUTONOMYS_API_KEY: "", IRYS_PAYMENT_PRIVATE_KEY: "" }),
    );

    expect(message).to.include("AUTONOMYS_API_KEY is missing");
    expect(message).to.include("IRYS_PAYMENT_PRIVATE_KEY is missing");
  });

  it("refuses a value it does not know, without printing it", () => {
    const value = "Zq9-unknown-provider";
    const message = problemsOf(env({ STORAGE_PROVIDER: value }));

    expect(message).to.include("STORAGE_PROVIDER is not a supported value");
    expect(message).to.include("irys");
    expect(message).to.include("autonomys-only");
    expect(message).to.not.include(value);
    expect(message).to.not.include("did you mean");
  });

  it("names the supported value a slip is closest to", () => {
    const message = problemsOf(env({ STORAGE_PROVIDER: "autonomys-onyl" }));

    expect(message).to.include('did you mean "autonomys-only"?');
    expect(message).to.not.include('"autonomys-onyl"');
  });

  it("does not ask about the value under mock storage, which never reads it for a provider", () => {
    expect(problemsOf(env({ USE_MOCK_STORAGE: "true", STORAGE_PROVIDER: "autonomys" }))).to.equal(
      null,
    );
  });
});
