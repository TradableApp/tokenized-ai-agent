const util = require("node:util");

const { expect } = require("chai");
const sinon = require("sinon");
const proxyquire = require("proxyquire").noCallThru();

const { clearPostgresEnv, setFullPostgresEnv } = require("./helpers/postgresTestEnv");

/**
 * Each module that prints an error, alerts about it or puts it in an error it throws is given an
 * error whose message carries a provider address with an access key, the way ethers and fetch
 * report a failed request. Nothing it prints, alerts or throws may carry the key.
 *
 * `describedErrorsGuard.test.js` reads the source for the forms it knows; these run the code.
 */
const KEY = "Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Jh1Gf0Ed";
const LEAKY_URL = `https://rpc.example/v2/${KEY}`;
const leakyError = () => new Error(`request to ${LEAKY_URL} failed, reason: socket hang up`);

/** Everything written to the console while `fn` runs, one string per call. */
async function printedBy(fn) {
  const printed = [];
  const methods = ["log", "info", "warn", "error", "debug"];
  const stubs = methods.map((method) =>
    sinon.stub(console, method).callsFake((...args) => {
      printed.push(util.format(...args));
    }),
  );
  let thrown = null;
  try {
    await fn();
  } catch (error) {
    thrown = error;
  } finally {
    stubs.forEach((stub) => stub.restore());
  }
  return { printed, thrown, text: printed.join("\n") };
}

/** Every argument of every call to a sinon stub, as text. */
const argumentsOf = (stub) =>
  stub
    .getCalls()
    .flatMap((call) => call.args)
    .map((arg) => util.format(arg))
    .join("\n");

/** The text of a thrown error: its message and stack, as the crash handler would print them. */
const thrownText = (error) => (error ? `${error.message}\n${error.stack}` : "");

function withEnv(values) {
  const saved = {};
  for (const [name, value] of Object.entries(values)) {
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

describe("errors printed by the oracle carry no access key", () => {
  afterEach(() => sinon.restore());

  describe("alerting", () => {
    let restoreEnv;

    afterEach(() => restoreEnv?.());

    it("describes a Slack failure", async () => {
      restoreEnv = withEnv({ SLACK_ACCESS_TOKEN: "xoxb-made-up", SLACK_ALERT_CHANNEL: "#alerts" });
      const { sendAlert } = proxyquire("../src/alerting", {
        "@slack/web-api": {
          WebClient: function WebClient() {
            return { chat: { postMessage: sinon.stub().rejects(leakyError()) } };
          },
        },
      });

      const { text } = await printedBy(() => sendAlert("Title", "Body"));

      expect(text).to.include("Failed to send Slack alert");
      expect(text).to.not.include(KEY);
    });

    it("describes an email failure", async () => {
      restoreEnv = withEnv({
        SLACK_ACCESS_TOKEN: undefined,
        ALERT_EMAIL_ENABLED: "true",
        SEND_GRID_API_KEY: "SG.made-up",
        SEND_GRID_ALERT_TEMPLATE_ID: "d-made-up",
        ALERT_FROM_EMAIL: "from@example.com",
        ALERT_TO_EMAIL: "to@example.com",
      });
      sinon.stub(global, "fetch").rejects(leakyError());
      const { sendAlert } = proxyquire("../src/alerting", {
        "@slack/web-api": { WebClient: function WebClient() {} },
      });

      const { text } = await printedBy(() => sendAlert("Title", "Body"));

      expect(text).to.include("Failed to send email alert");
      expect(text).to.not.include(KEY);
    });
  });

  describe("answerActivity", () => {
    it("names only the kind of a failed write, never its message", async () => {
      const wallet = "0x1111111111111111111111111111111111111111";
      const failure = Object.assign(leakyError(), { code: "ECONNRESET" });
      failure.message += ` for ${wallet}`;
      const { recordAnswerActivity } = proxyquire("../src/answerActivity", {
        "./brainContext": {
          getHandles: async () => ({
            brain: { recordActivity: async () => Promise.reject(failure) },
            ctx: {},
          }),
        },
      });

      const { text } = await printedBy(() =>
        recordAnswerActivity({ answerMessageId: 7n, kind: "answer", userWallet: wallet }),
      );

      expect(text).to.include("[AnswerActivity] Failed to record answer");
      expect(text).to.include("ECONNRESET");
      expect(text).to.not.include(KEY);
      expect(text).to.not.include(wallet);
    });
  });

  describe("brainContext", () => {
    let brainContext;

    beforeEach(() => {
      brainContext = require("../src/brainContext");
      brainContext._resetForTests();
      clearPostgresEnv();
      setFullPostgresEnv();
      brainContext._setTestOverrides({ loadBrain: async () => Promise.reject(leakyError()) });
    });

    afterEach(() => {
      brainContext._resetForTests();
      clearPostgresEnv();
    });

    it("describes a market context failure", async () => {
      const { text } = await printedBy(() => brainContext.getMarketContext());

      expect(text).to.include("[BrainContext] Market context unavailable");
      expect(text).to.not.include(KEY);
    });

    it("describes a failure to resolve the handles", async () => {
      const { text } = await printedBy(() => brainContext.getHandles());

      expect(text).to.include("[BrainContext] Handles unavailable");
      expect(text).to.not.include(KEY);
    });
  });

  describe("geminiDirect", () => {
    const PROMPT = "Should I move my savings into ZQX before the unlock on Friday?";
    let restoreEnv;
    let classifyIntent;

    beforeEach(() => {
      restoreEnv = withEnv({
        GOOGLE_GENERATIVE_AI_API_KEY: "made-up-gemini-key",
        GOOGLE_SMALL_MODEL: "made-up-small-model",
      });
      ({ classifyIntent } = require("../src/geminiDirect"));
    });

    afterEach(() => restoreEnv());

    it("describes a failed classification", async () => {
      const fetchImpl = sinon.stub().rejects(leakyError());

      const { text } = await printedBy(() =>
        classifyIntent([{ role: "user", content: PROMPT }], { fetchImpl }),
      );

      expect(text).to.include("[Routing] Classification failed");
      expect(text).to.not.include(KEY);
    });

    it("logs the length of the message it classifies, never its text", async () => {
      const fetchImpl = sinon.stub().resolves({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: '{"category":"MARKET"}' }] } }],
        }),
      });

      const { text } = await printedBy(() =>
        classifyIntent([{ role: "user", content: PROMPT }], { fetchImpl }),
      );

      expect(text).to.include(`${PROMPT.length} characters`);
      expect(text).to.not.include(PROMPT.slice(0, 20));
    });
  });

  describe("inboundPrompt", () => {
    it("describes a Brain that does not load in the error it throws", async () => {
      const { initInboundPrompt } = require("../src/inboundPrompt");

      const { thrown } = await printedBy(() =>
        initInboundPrompt({ loadBrain: async () => Promise.reject(leakyError()) }),
      );

      expect(thrown?.message).to.include("Could not load the Brain");
      expect(thrownText(thrown)).to.not.include(KEY);
    });
  });

  describe("index (start-up)", () => {
    it("prints a configuration error without the value of any setting", async () => {
      const exit = sinon.stub(process, "exit");
      sinon.stub(process, "on");
      class ConfigError extends Error {}
      const configError = new ConfigError(
        `Refusing to start — 1 configuration problem(s):\n  - AI_AGENT_CONTRACT_ADDRESS ${LEAKY_URL}`,
      );

      const { text } = await printedBy(() =>
        proxyquire("../src/index", {
          "./sentryInit": { initSentry: () => {} },
          "@sentry/node": { captureException: () => {}, flush: async () => {} },
          "./oracleKeys": { obtainOracleKeys: () => new Promise(() => {}) },
          "./secretValues": { wrapConsole: () => {} },
          "./startupConfig": {
            ConfigError,
            validateConfig: () => {
              throw configError;
            },
          },
        }),
      );

      sinon.assert.calledWith(exit, 1);
      expect(text).to.include("AI_AGENT_CONTRACT_ADDRESS");
      expect(text).to.not.include(KEY);
    });

    // The last line printed before the process ends. A peer address from the documentation
    // range stands in for a database the oracle could not reach.
    const PEER = "192.0.2.10";
    const crashError = () =>
      Object.assign(new Error(`connect ECONNREFUSED ${PEER}:5432 via ${LEAKY_URL}`), {
        code: "ECONNREFUSED",
        address: PEER,
        port: 5432,
      });

    /** The handlers index registers on the process, by event name. */
    function crashHandlers() {
      sinon.stub(process, "exit");
      const on = sinon.stub(process, "on");
      proxyquire("../src/index", {
        "./sentryInit": { initSentry: () => {} },
        "@sentry/node": { captureException: () => {}, flush: async () => {} },
        "./oracleKeys": { obtainOracleKeys: () => new Promise(() => {}) },
        "./secretValues": { wrapConsole: () => {} },
        "./startupConfig": { ConfigError: class extends Error {}, validateConfig: () => {} },
      });
      return Object.fromEntries(on.getCalls().map((call) => [call.args[0], call.args[1]]));
    }

    for (const event of ["unhandledRejection", "uncaughtException"]) {
      it(`describes what reaches the ${event} handler`, async () => {
        const handlers = crashHandlers();
        expect(handlers[event], event).to.be.a("function");

        const { text } = await printedBy(() => handlers[event](crashError()));

        expect(text).to.include("[Fatal]");
        expect(text).to.include("ECONNREFUSED");
        expect(text).to.not.include(KEY);
        expect(text).to.not.include(PEER);
      });
    }
  });

  describe("startupConfig", () => {
    it("names a setting with a bad value and never prints the value", () => {
      const { validateConfig } = require("../src/startupConfig");
      let thrown;
      try {
        validateConfig({
          ...process.env,
          NETWORK_NAME: LEAKY_URL,
          AI_AGENT_CONTRACT_ADDRESS: LEAKY_URL,
          POLL_INTERVAL_MS: LEAKY_URL,
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown?.message).to.include("NETWORK_NAME");
      expect(thrown?.message).to.include("AI_AGENT_CONTRACT_ADDRESS");
      expect(thrown?.message).to.include("POLL_INTERVAL_MS");
      expect(thrown.message).to.not.include(KEY);
    });

    // A short key pasted into the wrong setting looks like a name, so the value itself is never
    // printed: a misspelt name is answered with the supported name it is closest to.
    it("names the supported network a misspelt one is closest to, never the value", () => {
      const { validateConfig } = require("../src/startupConfig");
      const { SUPPORTED_NETWORKS } = require("../src/contractUtility");
      const supported = SUPPORTED_NETWORKS.find((name) => name.length > 6);
      const misspelt = `${supported.slice(0, -1)}x`;
      let thrown;
      try {
        validateConfig({ ...process.env, NETWORK_NAME: misspelt });
      } catch (error) {
        thrown = error;
      }
      let unlike;
      try {
        validateConfig({ ...process.env, NETWORK_NAME: "Zx9Yw8Vu7Ts6Rq5P" });
      } catch (error) {
        unlike = error;
      }

      expect(thrown?.message).to.include(`did you mean "${supported}"`);
      expect(thrown.message).to.not.include(misspelt);
      expect(unlike?.message).to.include("NETWORK_NAME is not a supported network");
      expect(unlike.message).to.not.include("did you mean");
      expect(unlike.message).to.not.include("Zx9Yw8Vu7Ts6Rq5P");
    });

    it("names the storage provider a misspelt one is closest to, never the value", () => {
      const { validateConfig } = require("../src/startupConfig");
      let thrown;
      try {
        validateConfig({
          ...process.env,
          USE_MOCK_STORAGE: "false",
          LOCAL_IPFS_API_URL: "",
          STORAGE_PROVIDER: "iris",
          AUTONOMYS_API_KEY: "",
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown?.message).to.include('STORAGE_PROVIDER names a provider other than irys (did you mean "irys"?)');
      expect(thrown.message).to.not.include('"iris"');
    });
  });

  describe("oracleHeartbeat", () => {
    it("describes a failed beat and keeps its frames", async () => {
      const clock = sinon.useFakeTimers();
      const logger = { warn: sinon.stub() };
      const { startHeartbeat } = require("../src/oracleHeartbeat");
      const heartbeat = startHeartbeat({
        recordActivity: async () => {},
        ctx: {},
        collect: async () => Promise.reject(leakyError()),
        intervalMs: 1000,
        logger,
      });

      await clock.tickAsync(1000);
      heartbeat.stop();
      clock.restore();

      expect(argumentsOf(logger.warn)).to.include("[Heartbeat] Beat failed");
      expect(argumentsOf(logger.warn)).to.match(/\n\s+at /);
      expect(argumentsOf(logger.warn)).to.not.include(KEY);
    });

    it("describes a failure to resolve the Brain handles", async () => {
      const logger = { warn: sinon.stub() };
      const { startOracleHeartbeat } = proxyquire("../src/oracleHeartbeat", {
        "./brainContext": { getHandles: async () => Promise.reject(leakyError()) },
        "./oracleVitals": { collectVitals: async () => ({}) },
        "./providerTally": { providerTally: {} },
      });

      await startOracleHeartbeat({ logger });

      expect(argumentsOf(logger.warn)).to.include("Brain handles failed to resolve");
      expect(argumentsOf(logger.warn)).to.not.include(KEY);
    });
  });

  describe("eventLogQuery", () => {
    it("describes a failed report of an undecodable log", async () => {
      const { queryOracleWorkEvents } = require("../src/eventLogQuery");
      const contract = {
        filters: {},
        interface: { getEvent: () => ({ topicHash: "0x01" }) },
        queryFilter: async () => [{ blockNumber: 1, transactionHash: "0xab", index: 0 }],
      };

      const { text } = await printedBy(async () => {
        await queryOracleWorkEvents(contract, 0, 1, {
          onUndecodable: async () => Promise.reject(leakyError()),
        });
        await new Promise((resolve) => setImmediate(resolve));
      });

      expect(text).to.include("Reporting an undecodable log failed");
      expect(text).to.not.include(KEY);
    });
  });

  describe("outboundSanitizer", () => {
    const sanitizer = require("../src/outboundSanitizer");

    afterEach(() => sanitizer._resetForTests());

    it("describes a Brain that does not load", async () => {
      sanitizer._setSanitizerForTests(null, { loader: async () => Promise.reject(leakyError()) });

      const { text } = await printedBy(() => sanitizer.sanitizeAnswer("An answer."));

      expect(text).to.include("Could not load the Brain");
      expect(text).to.not.include(KEY);
    });

    it("names only the kind of a sanitiser that throws, never its message", async () => {
      sanitizer._setSanitizerForTests(() => {
        throw new TypeError(`could not clean "An answer about ${LEAKY_URL}"`);
      });

      const { text } = await printedBy(() => sanitizer.sanitizeAnswer("An answer."));

      expect(text).to.include("Sanitiser threw");
      expect(text).to.include("TypeError");
      expect(text).to.not.include(KEY);
      expect(text).to.not.include("An answer about");
    });
  });

  describe("payloadValidator", () => {
    const { validatePayload } = require("../src/payloadValidator");

    it("keeps the kind of a failed validation and drops its message", () => {
      const payload = {
        get promptText() {
          throw leakyError();
        },
      };
      let thrown;
      try {
        validatePayload(payload, "PromptSubmitted");
      } catch (error) {
        thrown = error;
      }

      expect(thrown?.message).to.include("Validation Failed for PromptSubmitted");
      expect(thrownText(thrown)).to.not.include(KEY);
    });

    // Which field failed and how is the schema's text, not the user's: it is kept. What was
    // received, and the issue's own message, are not.
    it("names each failing field and the kind of its failure, and never the value", () => {
      let thrown;
      try {
        validatePayload(
          { promptText: "", isNewConversation: "Should I sell everything now" },
          "PromptSubmitted",
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown?.message).to.include("ZodError");
      expect(thrown.message).to.include("promptText too_small");
      expect(thrown.message).to.include("isNewConversation invalid_type");
      expect(thrown.message).to.not.include("sell everything");
      expect(thrown.message).to.not.include("Expected");
    });

    it("does not quote the user's text from a payload that is not JSON", () => {
      let thrown;
      try {
        validatePayload('"Should I sell everything now', "PromptSubmitted");
      } catch (error) {
        thrown = error;
      }

      expect(thrown?.message).to.include("SyntaxError");
      expect(thrown.message).to.not.include("Unterminated");
      expect(thrown.message).to.not.include("sell everything");
    });
  });

  describe("storage/arweave", () => {
    let arweave;
    let sendAlert;
    let restoreEnv;

    beforeEach(async () => {
      restoreEnv = withEnv({
        IRYS_PAYMENT_PRIVATE_KEY: "made-up",
        IRYS_NETWORK: "devnet",
        IRYS_PAYMENT_RPC_URL: "made-up",
      });
      sendAlert = sinon.stub().resolves();
      const uploader = {
        upload: sinon.stub().rejects(leakyError()),
        getBalance: sinon.stub().resolves(10n ** 18n),
        getPrice: sinon.stub().resolves({ isGreaterThan: () => false }),
        utils: { fromAtomic: (value) => String(value) },
        address: "made-up",
      };
      const builder = {
        withWallet: sinon.stub().returnsThis(),
        withRpc: sinon.stub().returnsThis(),
        devnet: sinon.stub().resolves(uploader),
        then: (resolve) => resolve(uploader),
      };
      arweave = proxyquire("../src/storage/arweave", {
        "@irys/upload": { Uploader: () => builder },
        "@irys/upload-ethereum": { BaseEth: {} },
        "../alerting": { sendAlert },
      });
      await printedBy(() => arweave.initializeIrys());
    });

    afterEach(() => restoreEnv());

    it("describes a failed upload in the log and the alert", async () => {
      const { text, thrown } = await printedBy(() => arweave.uploadData(Buffer.from("{}")));

      expect(thrown).to.exist;
      expect(text).to.include("Upload to Irys failed");
      expect(text).to.not.include(KEY);
      expect(argumentsOf(sendAlert)).to.not.include(KEY);
    });

    it("describes a failed tag query", async () => {
      sinon.stub(global, "fetch").rejects(leakyError());

      const { text } = await printedBy(() =>
        arweave.queryTransactionByTags([{ name: "File-Name", value: "x" }]),
      );

      expect(text).to.include("Error querying Irys GQL for tags");
      expect(text).to.not.include(KEY);
    });
  });

  describe("storage/autonomys", () => {
    let autonomys;
    let sendAlert;
    let api;
    let restoreEnv;

    const accountReply = {
      ok: true,
      status: 200,
      json: async () => ({ pendingUploadCredits: 10 ** 12, pendingDownloadCredits: 10 ** 12 }),
    };

    beforeEach(async () => {
      restoreEnv = withEnv({ AUTONOMYS_API_KEY: "made-up" });
      sendAlert = sinon.stub().resolves();
      api = {
        uploadFile: sinon.stub().rejects(leakyError()),
        downloadFile: sinon.stub().rejects(leakyError()),
        searchByNameOrCIDInMyFiles: sinon.stub().rejects(leakyError()),
        getMyFiles: sinon.stub().rejects(leakyError()),
      };
      autonomys = proxyquire("../src/storage/autonomys", {
        "@autonomys/auto-drive": { createAutoDriveApi: () => api },
        "@autonomys/auto-utils": { NetworkId: { MAINNET: "mainnet", TAURUS: "taurus" } },
        "../alerting": { sendAlert },
      });
    });

    afterEach(() => restoreEnv());

    async function initialised() {
      sinon.stub(global, "fetch").resolves(accountReply);
      await printedBy(() => autonomys.initializeAutoDrive());
      global.fetch.restore();
    }

    it("describes a failed credit check in the log and the alert", async () => {
      sinon.stub(global, "fetch").rejects(leakyError());

      const { text } = await printedBy(() => autonomys.initializeAutoDrive());

      expect(text).to.include("Failed to check Autonomys Auto Drive credits");
      expect(text).to.not.include(KEY);
      expect(argumentsOf(sendAlert)).to.not.include(KEY);
    });

    it("describes a credit check that fails before an upload", async () => {
      await initialised();
      sinon.stub(global, "fetch").rejects(leakyError());

      const { text, thrown } = await printedBy(() => autonomys.uploadData(Buffer.from("{}")));

      expect(text).to.include("Credit sufficiency check failed");
      expect(text).to.not.include(KEY);
      expect(thrownText(thrown)).to.not.include(KEY);
      expect(argumentsOf(sendAlert)).to.not.include(KEY);
    });

    it("describes a credit check that fails transiently in the error it throws", async () => {
      await initialised();
      sinon
        .stub(global, "fetch")
        .rejects(new Error(`fetch failed: 503 Service Unavailable ${LEAKY_URL}`));

      const { thrown } = await printedBy(() => autonomys.uploadData(Buffer.from("{}")));

      expect(thrown?.message).to.include("Autonomys credit check failed transiently");
      expect(thrownText(thrown)).to.not.include(KEY);
    });

    it("describes a failed upload in the log and the alert", async () => {
      await initialised();
      sinon.stub(global, "fetch").resolves(accountReply);

      const { text, thrown } = await printedBy(() => autonomys.uploadData(Buffer.from("{}")));

      expect(thrown).to.exist;
      expect(text).to.include("Upload to Autonomys Auto Drive failed");
      expect(text).to.not.include(KEY);
      expect(argumentsOf(sendAlert)).to.not.include(KEY);
    });

    it("describes each retried upload and the error that ends the retries", async () => {
      await initialised();
      sinon.stub(global, "fetch").resolves(accountReply);
      api.uploadFile.rejects(new Error(`Service Unavailable at ${LEAKY_URL}`));

      const { text, thrown } = await printedBy(() =>
        autonomys.uploadData(Buffer.from("{}"), [], { sleep: async () => {} }),
      );

      expect(text).to.include("retrying");
      expect(text).to.not.include(KEY);
      expect(thrownText(thrown)).to.not.include(KEY);
      expect(argumentsOf(sendAlert)).to.not.include(KEY);
    });

    it("describes a failed download in the log and the alert", async () => {
      await initialised();

      const { text, thrown } = await printedBy(() => autonomys.fetchData("bafy-made-up"));

      expect(thrown).to.exist;
      expect(text).to.include("Failed to fetch CID bafy-made-up");
      expect(text).to.not.include(KEY);
      expect(argumentsOf(sendAlert)).to.not.include(KEY);
    });

    it("describes a failed tag query and a failed listing", async () => {
      await initialised();

      const query = await printedBy(() =>
        autonomys.queryTransactionByTags([{ name: "File-Name", value: "x" }]),
      );
      const listing = await printedBy(() => autonomys.listMyFiles());

      expect(query.text).to.include("Error querying Autonomys Auto Drive for tags");
      expect(listing.text).to.include("Error listing Autonomys files");
      expect(query.text + listing.text).to.not.include(KEY);
    });
  });

  describe("storage/uploadRetry", () => {
    it("describes the last error in the error that ends the retries", async () => {
      const { uploadWithRetry } = require("../src/storage/uploadRetry");

      const { thrown } = await printedBy(() =>
        uploadWithRetry(async () => Promise.reject(new Error(`Service Unavailable ${LEAKY_URL}`)), {
          sleep: async () => {},
        }),
      );

      expect(thrown?.message).to.include("Autonomys upload failed after");
      expect(thrownText(thrown)).to.not.include(KEY);
    });
  });

  describe("storage/mirror", () => {
    const env = { PAYLOAD_MIRROR_BUCKET: "made-up-bucket" };
    let mirror;

    beforeEach(() => {
      mirror = require("../src/storage/mirror");
      mirror._resetForTest();
    });

    afterEach(() => mirror._resetForTest());

    it("describes a failed request in the log and the alert", async () => {
      const alert = sinon.stub().resolves();

      const { text } = await printedBy(() =>
        mirror.mirrorPayload("bafy-made-up", "{}", "f.json", {
          env,
          fetchImpl: sinon.stub().rejects(leakyError()),
          getToken: async () => "made-up-token",
          sleep: async () => {},
          alert,
        }),
      );

      expect(text).to.include("Failed to mirror bafy-made-up");
      expect(text).to.not.include(KEY);
      expect(argumentsOf(alert)).to.not.include(KEY);
    });

    it("describes an error response's body in the log and the alert", async () => {
      const alert = sinon.stub().resolves();

      const { text } = await printedBy(() =>
        mirror.mirrorPayload("bafy-made-up", "{}", "f.json", {
          env,
          fetchImpl: sinon.stub().resolves({ ok: false, status: 403, text: async () => LEAKY_URL }),
          getToken: async () => "made-up-token",
          sleep: async () => {},
          alert,
        }),
      );

      expect(text).to.include("HTTP 403");
      expect(text).to.not.include(KEY);
      expect(argumentsOf(alert)).to.not.include(KEY);
    });

    it("describes an unexpected error and a failed alert", async () => {
      const deps = {
        get env() {
          throw leakyError();
        },
        alert: sinon.stub().rejects(leakyError()),
      };

      const { text } = await printedBy(() =>
        mirror.mirrorInBackground("bafy-made-up", "{}", "f.json", deps),
      );

      expect(text).to.include("Unexpected error mirroring bafy-made-up");
      expect(text).to.include("Alert delivery failed");
      expect(text).to.not.include(KEY);
      expect(argumentsOf(deps.alert)).to.not.include(KEY);
    });
  });

  describe("storage/storage", () => {
    it("describes failed tag queries on both providers", async () => {
      const restoreEnv = withEnv({
        USE_MOCK_STORAGE: undefined,
        STORAGE_PROVIDER: undefined,
        LOCAL_IPFS_API_URL: undefined,
      });
      const storage = proxyquire("../src/storage/storage", {
        "./arweave": { queryTransactionByTags: sinon.stub().rejects(leakyError()) },
        "./autonomys": { queryTransactionByTags: sinon.stub().rejects(leakyError()) },
        "./ipfs": {},
        "./mirror": {},
      });

      const { text } = await printedBy(() =>
        storage.queryTransactionByTags([{ name: "File-Name", value: "x" }]),
      );
      restoreEnv();

      expect(text).to.include("Error querying Autonomys tags");
      expect(text).to.include("Error querying Arweave tags");
      expect(text).to.not.include(KEY);
    });
  });
});
