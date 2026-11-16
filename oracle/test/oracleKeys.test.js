const { expect } = require("chai");
const { ethers } = require("ethers");
const util = require("util");

const { eciesEncrypt } = require("../src/ecies");
const {
  createDecryptor,
  keyIdsFor,
  keyModeFor,
  obtainOracleKeys,
  CHAIN_IDS,
} = require("../src/oracleKeys");
const { redactSecrets, forgetSecretValuesForTest } = require("../src/secretValues");

const SIGNER_KEY = "11".repeat(32);
const DECRYPTION_KEY = "22".repeat(32);
const ENV_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const AGENT = "0x4a0C7e5807f9174499a8F56F2C69c61b39a4c64D";

const bytes = (hex) => new Uint8Array(Buffer.from(hex.replace(/^0x/, ""), "hex"));

/** An env that fails the test if the operator-set key is so much as read. */
function envWithoutKeyAccess(values) {
  return new Proxy(values, {
    get(target, name) {
      if (name === "PRIVATE_KEY") throw new Error("PRIVATE_KEY was read");

      return target[name];
    },
  });
}

/** A key service that answers from a map of key id endings, and counts its calls. */
function keyService(answers = { "evm-signer": SIGNER_KEY, "prompt-decryption": DECRYPTION_KEY }) {
  const calls = [];
  const generateKey = async (keyId, kind) => {
    calls.push({ keyId, kind });
    const ending = Object.keys(answers).find((name) => keyId.endsWith(name));
    const answer = answers[ending];
    if (answer instanceof Error) throw answer;

    return bytes(answer);
  };

  return { generateKey, calls };
}

/** A clock that only moves when the code under test sleeps. */
function clock() {
  let nowMs = 0;
  const sleeps = [];

  return {
    now: () => nowMs,
    sleep: async (ms) => {
      sleeps.push(ms);
      nowMs += ms;
    },
    sleeps,
  };
}

const quiet = { log() {}, warn() {}, error() {} };

describe("oracle keys", () => {
  afterEach(() => forgetSecretValuesForTest());

  describe("where the keys come from", () => {
    it("is the environment on a local network only", () => {
      for (const network of ["base-localnet", "sapphire-localnet"]) {
        expect(keyModeFor(network), network).to.equal("env");
      }
    });

    it("is the ROFL key service on every other network, including one not known", () => {
      for (const network of ["base", "baseSepolia", "sapphire", "sapphire-testnet", "anything"]) {
        expect(keyModeFor(network), network).to.equal("rofl");
      }
    });
  });

  describe("key ids", () => {
    // Changing an id changes the keys: a new oracle address and a key no stored prompt was
    // encrypted to. These strings are the deployed identity.
    it("are these exact strings", () => {
      expect(keyIdsFor("baseSepolia", AGENT)).to.deep.equal({
        signer: "senseai-oracle/v1/84532/0x4a0c7e5807f9174499a8f56f2c69c61b39a4c64d/evm-signer",
        decryption:
          "senseai-oracle/v1/84532/0x4a0c7e5807f9174499a8f56f2c69c61b39a4c64d/prompt-decryption",
      });
      expect(keyIdsFor("base", AGENT).signer).to.equal(
        "senseai-oracle/v1/8453/0x4a0c7e5807f9174499a8f56f2c69c61b39a4c64d/evm-signer",
      );
    });

    it("know the chain of every network that is not local", () => {
      expect(CHAIN_IDS).to.deep.equal({
        base: 8453,
        baseSepolia: 84532,
        sapphire: 23294,
        "sapphire-testnet": 23295,
      });
    });

    it("cannot be made for a network whose chain is not known, or without the agent", () => {
      expect(() => keyIdsFor("anything", AGENT)).to.throw(/chain id/);
      expect(() => keyIdsFor("base", "0xYourAIAgentAddressHere")).to.throw(/agent address/);
    });
  });

  describe("on a local network", () => {
    it("uses PRIVATE_KEY for signing and decryption, and asks the key service nothing", async () => {
      const service = keyService();

      const keys = await obtainOracleKeys({
        env: { NETWORK_NAME: "base-localnet", PRIVATE_KEY: ENV_KEY },
        generateKey: service.generateKey,
        log: quiet,
      });

      expect(keys.mode).to.equal("env");
      expect(keys.signingKeyHex()).to.equal(ENV_KEY);
      expect(keys.decryptor.publicKey).to.equal(new ethers.SigningKey(ENV_KEY).publicKey);
      expect(service.calls).to.deep.equal([]);
    });
  });

  describe("on a network that is not local", () => {
    const env = (extra = {}) =>
      envWithoutKeyAccess({
        NETWORK_NAME: "baseSepolia",
        AI_AGENT_CONTRACT_ADDRESS: AGENT,
        ...extra,
      });

    it("takes both keys from the key service and never reads PRIVATE_KEY", async () => {
      const service = keyService();

      const keys = await obtainOracleKeys({
        env: env(),
        generateKey: service.generateKey,
        getAppId: async () => "rofl1app",
        log: quiet,
      });

      expect(keys.mode).to.equal("rofl");
      expect(keys.signingKeyHex()).to.equal(`0x${SIGNER_KEY}`);
      expect(keys.decryptor.publicKey).to.equal(
        new ethers.SigningKey(`0x${DECRYPTION_KEY}`).publicKey,
      );
      expect(service.calls).to.deep.equal([
        { keyId: keyIdsFor("baseSepolia", AGENT).signer, kind: "secp256k1" },
        { keyId: keyIdsFor("baseSepolia", AGENT).decryption, kind: "secp256k1" },
      ]);
    });

    it("prints one identity line that holds public values only", async () => {
      const lines = [];
      const service = keyService();

      await obtainOracleKeys({
        env: env(),
        generateKey: service.generateKey,
        getAppId: async () => "rofl1app",
        log: { ...quiet, log: (...args) => lines.push(args.join(" ")) },
      });

      const identity = lines.filter((line) => line.startsWith("[OracleKeys] mode=rofl"));
      expect(identity).to.have.length(1);
      expect(identity[0]).to.include("app=rofl1app");
      expect(identity[0]).to.include(`signer=${new ethers.Wallet(`0x${SIGNER_KEY}`).address}`);
      expect(identity[0]).to.include(
        `encryptionKey=${new ethers.SigningKey(`0x${DECRYPTION_KEY}`).publicKey}`,
      );
      expect(identity[0]).to.include("attempts=1");
      expect(lines.join("\n")).to.not.include(SIGNER_KEY);
      expect(lines.join("\n")).to.not.include(DECRYPTION_KEY);
    });

    it("still starts when the app id cannot be read", async () => {
      const lines = [];

      await obtainOracleKeys({
        env: env(),
        generateKey: keyService().generateKey,
        getAppId: async () => {
          throw new Error("no socket");
        },
        log: { ...quiet, log: (...args) => lines.push(args.join(" ")) },
      });

      expect(lines.join("\n")).to.include("app=unknown");
    });

    it("registers both keys so nothing can print them", async () => {
      await obtainOracleKeys({
        env: env(),
        generateKey: keyService().generateKey,
        getAppId: async () => "rofl1app",
        log: quiet,
      });

      expect(redactSecrets(`${SIGNER_KEY} ${DECRYPTION_KEY}`)).to.equal("[REDACTED] [REDACTED]");
    });

    it("waits and asks again while the key service is not there, from 1 s up to 30 s", async () => {
      const time = clock();
      let failuresLeft = 8;
      const service = keyService();
      const generateKey = async (...args) => {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error("connect ENOENT /run/rofl-appd.sock");
        }

        return service.generateKey(...args);
      };

      const keys = await obtainOracleKeys({
        env: env(),
        generateKey,
        getAppId: async () => "rofl1app",
        sleep: time.sleep,
        now: time.now,
        alert: async () => {},
        log: quiet,
      });

      expect(time.sleeps).to.deep.equal([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
      expect(keys.mode).to.equal("rofl");
    });

    it("alerts after two minutes without keys, again each hour, and once when they arrive", async () => {
      const time = clock();
      const alerts = [];
      let failing = true;
      const service = keyService();
      const generateKey = async (...args) => {
        // Stop failing a little after the second hourly reminder is due.
        if (time.now() > 2 * 60 * 60 * 1000 + 5 * 60 * 1000) failing = false;
        if (failing) throw new Error("Status 400 from the key service (15 bytes)");

        return service.generateKey(...args);
      };

      await obtainOracleKeys({
        env: env(),
        generateKey,
        getAppId: async () => "rofl1app",
        sleep: time.sleep,
        now: time.now,
        alert: async (title, message) => alerts.push({ title, message, at: time.now() }),
        log: quiet,
      });

      const critical = alerts.filter((a) => a.title.startsWith("CRITICAL"));
      expect(critical).to.have.length(3);
      expect(critical[0].title).to.equal("CRITICAL: Oracle cannot obtain its keys from ROFL");
      expect(critical[0].at).to.be.within(2 * 60 * 1000, 2 * 60 * 1000 + 30 * 1000);
      expect(critical[1].at - critical[0].at).to.be.within(60 * 60 * 1000, 60 * 60 * 1000 + 30000);
      expect(critical[0].message).to.include("Status 400");
      expect(alerts[alerts.length - 1].title).to.match(/^RESOLVED/);
    });

    it("sends no alert when the keys arrive before two minutes are up", async () => {
      const time = clock();
      const alerts = [];
      let failuresLeft = 3;
      const service = keyService();

      await obtainOracleKeys({
        env: env(),
        generateKey: async (...args) => {
          if (failuresLeft-- > 0) throw new Error("not initialized");

          return service.generateKey(...args);
        },
        getAppId: async () => "rofl1app",
        sleep: time.sleep,
        now: time.now,
        alert: async (title) => alerts.push(title),
        log: quiet,
      });

      expect(alerts).to.deep.equal([]);
    });

    it("never falls back to PRIVATE_KEY, however long the key service is away", async () => {
      const time = clock();
      let asked = 0;
      const stop = new Error("stop the test");

      const waiting = obtainOracleKeys({
        // Reading PRIVATE_KEY throws, so a fallback would fail this test with that error.
        env: env(),
        generateKey: async () => {
          asked += 1;
          if (asked > 300) throw stop;
          throw new Error("connect ENOENT");
        },
        getAppId: async () => "rofl1app",
        sleep: async (ms) => {
          if (asked > 300) throw stop;
          await time.sleep(ms);
        },
        now: time.now,
        alert: async () => {},
        log: quiet,
      });

      let failure;
      try {
        await waiting;
      } catch (error) {
        failure = error;
      }
      expect(failure).to.equal(stop);
      expect(time.now()).to.be.greaterThan(2 * 60 * 60 * 1000);
    });

    it("does not accept one key for both purposes", async () => {
      const time = clock();
      let asked = 0;
      const stop = new Error("stop the test");
      const alerts = [];

      let failure;
      try {
        await obtainOracleKeys({
          env: env(),
          generateKey: async () => {
            asked += 1;

            return bytes(SIGNER_KEY);
          },
          getAppId: async () => "rofl1app",
          // Thrown from the wait, which the retry does not catch, to end a loop that has no end.
          sleep: async (ms) => {
            if (asked > 40) throw stop;
            await time.sleep(ms);
          },
          now: time.now,
          alert: async (title, message) => alerts.push(message),
          log: quiet,
        });
      } catch (error) {
        failure = error;
      }

      expect(failure).to.equal(stop);
      expect(alerts[0]).to.include("same key");
      expect(alerts.join("\n")).to.not.include(SIGNER_KEY);
    });

    it("says only what is public when it reports a failure", async () => {
      const time = clock();
      const printed = [];
      let asked = 0;
      const service = keyService();

      await obtainOracleKeys({
        env: env(),
        generateKey: async (...args) => {
          asked += 1;
          if (asked === 1) {
            throw new Error("request to https://rpc.example/v2/access-key-123 failed");
          }

          return service.generateKey(...args);
        },
        getAppId: async () => "rofl1app",
        sleep: time.sleep,
        now: time.now,
        alert: async () => {},
        log: { ...quiet, warn: (...args) => printed.push(args.join(" ")) },
      });

      expect(printed.join("\n")).to.include("[OracleKeys]");
      expect(printed.join("\n")).to.not.include("access-key-123");
    });
  });

  describe("the decryptor", () => {
    it("decrypts what was encrypted to its public key", async () => {
      const decryptor = createDecryptor(bytes(DECRYPTION_KEY));
      const blob = await eciesEncrypt(decryptor.publicKey, Buffer.from("a session key"));

      expect((await decryptor.decrypt(blob)).toString()).to.equal("a session key");
    });

    it("has a 65-byte uncompressed public key, as the agent contract requires", () => {
      const { publicKey } = createDecryptor(bytes(DECRYPTION_KEY));

      expect(publicKey).to.match(/^0x04[0-9a-f]{128}$/);
    });

    // The statement and its encoding are the agent contract's (setOracleEncryptionKey). Written
    // out here and not shared with the code, so a change to either fails this test.
    it("proves it holds the key with the signature the agent contract checks", () => {
      const decryptor = createDecryptor(bytes(DECRYPTION_KEY));
      const publisher = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

      const proof = decryptor.proveKey({ chainId: 84532n, agentAddress: AGENT, publisher });

      const statement = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["string", "uint256", "address", "address", "bytes32"],
          [
            "SenseAI oracle encryption key v1",
            84532n,
            AGENT,
            publisher,
            ethers.keccak256(decryptor.publicKey),
          ],
        ),
      );
      const keyAddress = ethers.computeAddress(decryptor.publicKey);
      expect(ethers.getBytes(proof)).to.have.length(65);
      expect(ethers.verifyMessage(ethers.getBytes(statement), proof)).to.equal(keyAddress);
    });

    it("shows nothing of the key when printed, listed or serialised", () => {
      const decryptor = createDecryptor(bytes(DECRYPTION_KEY));

      const shown = util.inspect(decryptor, { depth: 5, showHidden: true });
      expect(shown).to.not.include(DECRYPTION_KEY);
      expect(JSON.stringify(decryptor)).to.not.include(DECRYPTION_KEY);
      expect(Object.keys(decryptor).sort()).to.deep.equal(["decrypt", "proveKey", "publicKey"]);
      expect(Object.isFrozen(decryptor)).to.equal(true);
    });

    it("refuses what is not a 32-byte key", () => {
      expect(() => createDecryptor(new Uint8Array(31))).to.throw(/32 bytes/);
    });
  });

  it("shows nothing of either key when the keys object is printed", async () => {
    const keys = await obtainOracleKeys({
      env: envWithoutKeyAccess({ NETWORK_NAME: "base", AI_AGENT_CONTRACT_ADDRESS: AGENT }),
      generateKey: keyService().generateKey,
      getAppId: async () => "rofl1app",
      log: quiet,
    });
    forgetSecretValuesForTest();

    const shown = util.inspect(keys, { depth: 5, showHidden: true }) + JSON.stringify(keys);
    expect(shown).to.not.include(SIGNER_KEY);
    expect(shown).to.not.include(DECRYPTION_KEY);
  });

  // The whole path a deployed oracle takes to its keys, against a socket that answers as the
  // key service does, with everything printed on the way captured.
  describe("against a key service socket", function () {
    const fs = require("fs");
    const http = require("http");
    const os = require("os");
    const path = require("path");

    const { generateKey, getAppId } = require("../src/roflUtility");
    const { wrapConsole } = require("../src/secretValues");

    let server;
    let socketPath;

    beforeEach((done) => {
      socketPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "appd-")), "appd.sock");
      server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          if (req.url === "/rofl/v1/app/id") return res.end("rofl1app");
          const { key_id: keyId } = JSON.parse(body);
          res.end(
            JSON.stringify({ key: keyId.endsWith("evm-signer") ? SIGNER_KEY : DECRYPTION_KEY }),
          );
        });
      });
      server.listen(socketPath, done);
    });

    afterEach((done) => {
      server.close(() => {
        fs.rmSync(path.dirname(socketPath), { recursive: true, force: true });
        done();
      });
    });

    it("prints neither key, whatever is logged afterwards", async () => {
      const printed = [];
      const log = {};
      for (const method of ["log", "info", "warn", "error", "debug"]) {
        log[method] = (...args) => printed.push(util.format(...args));
      }
      wrapConsole(log);

      const keys = await obtainOracleKeys({
        env: envWithoutKeyAccess({ NETWORK_NAME: "baseSepolia", AI_AGENT_CONTRACT_ADDRESS: AGENT }),
        generateKey: (keyId, kind) => generateKey(keyId, kind, socketPath),
        getAppId: () => getAppId(socketPath),
        log,
      });
      // What a careless line elsewhere could do with the keys in hand.
      log.log("keys:", keys);
      log.error(new Error(`wallet rejected ${keys.signingKeyHex()}`));
      log.warn({ leaked: DECRYPTION_KEY.toUpperCase() });

      const output = printed.join("\n").toLowerCase();
      expect(output).to.include("[oraclekeys] mode=rofl app=rofl1app");
      expect(output).to.not.include(SIGNER_KEY);
      expect(output).to.not.include(DECRYPTION_KEY);
    });
  });
});
