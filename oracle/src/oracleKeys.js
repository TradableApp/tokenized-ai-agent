/**
 * The oracle's two keys: the one that signs its transactions and the one that decrypts the
 * session key of each prompt.
 *
 * On a deployed network both are made by the ROFL key service inside the TEE. The same app and
 * key id always give the same key, on every machine of the app, across restarts, new images
 * and a wiped volume, so nothing is stored and no person ever holds either key. On a local
 * network there is no TEE, and both keys are PRIVATE_KEY as before.
 *
 * Which of the two applies follows from the network name alone. There is no setting for it: a
 * setting could be wrong, and a deployed oracle that quietly took an operator's key would look
 * exactly like one that did not.
 */

const { ethers } = require("ethers");
const fs = require("fs");

const { sendAlert } = require("./alerting");
const { eciesDecrypt } = require("./ecies");
const { describeError } = require("./errorDescription");
const rofl = require("./roflUtility");
const { registerSecretValue } = require("./secretValues");

/** Networks with no TEE, where the key is the operator's. */
const LOCAL_NETWORKS = new Set(["base-localnet", "sapphire-localnet"]);

/**
 * The chain of every deployed network. Part of the key id, so a key made for one chain is
 * never the key of another even if both run under one ROFL app.
 */
const CHAIN_IDS = Object.freeze({
  base: 8453,
  baseSepolia: 84532,
  sapphire: 23294,
  "sapphire-testnet": 23295,
});

// Raising this gives a new signer address and a new encryption key: the way to leave a key
// that may have leaked. Nothing else may change it.
const KEY_ID_VERSION = "v1";
const KEY_KIND = "secp256k1";

// The first field of the statement the agent contract checks when a key is published.
const ENCRYPTION_KEY_PROOF_DOMAIN = "SenseAI oracle encryption key v1";

const FIRST_RETRY_MS = 1000;
const LONGEST_RETRY_MS = 30 * 1000;
const ALERT_AFTER_MS = 2 * 60 * 1000;
const REMIND_EVERY_MS = 60 * 60 * 1000;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * @param {string} networkName
 * @returns {"env" | "rofl"}
 */
function keyModeFor(networkName) {
  return LOCAL_NETWORKS.has(networkName) ? "env" : "rofl";
}

/**
 * The ids the key service is asked for.
 * @param {string} networkName
 * @param {string} agentAddress The agent contract. Two deployments on one chain get two keys.
 * @returns {{ signer: string, decryption: string }}
 */
function keyIdsFor(networkName, agentAddress) {
  const chainId = CHAIN_IDS[networkName];
  if (chainId === undefined) {
    throw new Error(`No chain id is known for network "${networkName}", so it has no key ids`);
  }
  if (typeof agentAddress !== "string" || !ADDRESS.test(agentAddress)) {
    throw new Error("The agent address is not an address, so there are no key ids for it");
  }
  const base = `senseai-oracle/${KEY_ID_VERSION}/${chainId}/${agentAddress.toLowerCase()}`;

  return { signer: `${base}/evm-signer`, decryption: `${base}/prompt-decryption` };
}

/**
 * Wraps the decryption key so that the rest of the oracle can use it and cannot read it.
 *
 * @param {Uint8Array} privateKey 32 bytes.
 * @returns {Readonly<{
 *   publicKey: string,
 *   decrypt: (cipherBlob: Buffer | Uint8Array) => Promise<Buffer>,
 *   proveKey: (statement: { chainId: bigint | number, agentAddress: string, publisher: string }) => string,
 * }>}
 */
function createDecryptor(privateKey) {
  if (!(privateKey instanceof Uint8Array) || privateKey.length !== 32) {
    throw new Error("A decryption key is 32 bytes");
  }
  const key = Uint8Array.from(privateKey);
  const signingKey = new ethers.SigningKey(key);
  // 65 bytes, uncompressed: the form the agent contract stores and clients encrypt to.
  const { publicKey } = signingKey;

  return Object.freeze({
    publicKey,
    decrypt: (cipherBlob) => eciesDecrypt(key, cipherBlob),
    /**
     * The signature that lets `publisher` publish this key on the agent: it shows that whoever
     * publishes the key holds it. Only this one statement can be signed, so the decryption key
     * cannot be made to sign anything else.
     */
    proveKey: ({ chainId, agentAddress, publisher }) => {
      const statement = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["string", "uint256", "address", "address", "bytes32"],
          [
            ENCRYPTION_KEY_PROOF_DOMAIN,
            chainId,
            agentAddress,
            publisher,
            ethers.keccak256(publicKey),
          ],
        ),
      );

      return signingKey.sign(ethers.hashMessage(ethers.getBytes(statement))).serialized;
    },
  });
}

/** What the rest of the oracle is given: ways to use the keys, never the bytes. */
function keysFrom(mode, signingKey, decryptionKey) {
  const signingKeyHex = ethers.hexlify(signingKey);
  registerSecretValue(signingKey);
  registerSecretValue(decryptionKey);

  return Object.freeze({
    mode,
    /** For building the wallet. A function, so that printing the keys object shows no key. */
    signingKeyHex: () => signingKeyHex,
    signerAddress: ethers.computeAddress(signingKeyHex),
    decryptor: createDecryptor(decryptionKey),
  });
}

function keysFromEnv(env, log, keyServicePresent) {
  // The key service's socket exists only inside a ROFL machine. A machine whose settings name
  // a local network would otherwise run on whatever key those settings hold.
  if (keyServicePresent()) {
    throw new Error(
      `NETWORK_NAME "${env.NETWORK_NAME}" is a local network, but this is a ROFL machine; ` +
        "a local network's key is not used here",
    );
  }
  const privateKey = env.PRIVATE_KEY;
  if (typeof privateKey !== "string" || !privateKey.trim()) {
    throw new Error("PRIVATE_KEY is missing; a local network takes the oracle's key from it");
  }
  let bytes;
  try {
    bytes = ethers.getBytes(privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`);
    if (bytes.length !== 32) throw new Error("wrong length");
  } catch {
    // ethers' own message repeats the value it was given.
    throw new Error("PRIVATE_KEY is not a 32-byte hex key");
  }
  const keys = keysFrom("env", bytes, bytes);
  // The wallet is built from what the operator wrote, in the form they wrote it.
  const withOperatorForm = Object.freeze({ ...keys, signingKeyHex: () => privateKey });
  log.log(
    `[OracleKeys] mode=env signer=${keys.signerAddress} encryptionKey=${keys.decryptor.publicKey}`,
  );

  return withOperatorForm;
}

async function requestBothKeys(generateKey, ids) {
  const signingKey = await generateKey(ids.signer, KEY_KIND);
  const decryptionKey = await generateKey(ids.decryption, KEY_KIND);
  if (Buffer.from(signingKey).equals(Buffer.from(decryptionKey))) {
    // Two ids must give two keys. One key for both would let a leak on the signing path
    // expose every prompt, which is what two ids are for.
    throw new Error("The ROFL key service returned the same key for signing and for decryption");
  }

  return { signingKey, decryptionKey };
}

/**
 * Sends an alert without waiting for it. An alert that is slow to send (a paging service that
 * is itself down retries for a long time) must not hold back the next attempt at the keys.
 */
function page(alert, title, message) {
  try {
    Promise.resolve(alert(title, message)).catch(() => {});
  } catch {
    // An alert that cannot even be started changes nothing here.
  }
}

async function keysFromRofl({
  env,
  generateKey,
  getAppId,
  appIdTimeoutMs,
  sleep,
  now,
  alert,
  log,
}) {
  const ids = keyIdsFor(env.NETWORK_NAME, env.AI_AGENT_CONTRACT_ADDRESS);
  const startedAt = now();
  let attempts = 0;
  let waitMs = FIRST_RETRY_MS;
  let alertedAt = null;

  for (;;) {
    attempts += 1;
    try {
      // eslint-disable-next-line no-await-in-loop -- one attempt at a time is the point
      const { signingKey, decryptionKey } = await requestBothKeys(generateKey, ids);
      const keys = keysFrom("rofl", signingKey, decryptionKey);
      // Only for the line below. The keys are in hand; nothing waits on this.
      // eslint-disable-next-line no-await-in-loop
      const app = await Promise.race([
        Promise.resolve()
          .then(getAppId)
          .catch(() => "unknown"),
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve("unknown"), appIdTimeoutMs);
          timer.unref?.();
        }),
      ]);
      log.log(
        `[OracleKeys] mode=rofl app=${app} signer=${keys.signerAddress} ` +
          `encryptionKey=${keys.decryptor.publicKey} keyIds=${KEY_ID_VERSION} ` +
          `attempts=${attempts} acquiredInMs=${now() - startedAt}`,
      );
      if (alertedAt !== null) {
        page(
          alert,
          "RESOLVED: Oracle obtained its keys from ROFL",
          `After ${attempts} attempts over ${Math.round((now() - startedAt) / 60000)} minutes.`,
        );
      }

      return keys;
    } catch (error) {
      // There is nothing to fall back to, on purpose. A restart would not bring the key
      // service back either, so the oracle waits; prompts stay pending and are refunded after
      // the hour, as in any outage.
      const described = describeError(error);
      log.warn(
        `[OracleKeys] The ROFL key service gave no keys (attempt ${attempts}): ${described}. ` +
          `Asking again in ${waitMs / 1000} s.`,
      );
      const waited = now() - startedAt;
      const due =
        alertedAt === null ? waited >= ALERT_AFTER_MS : now() - alertedAt >= REMIND_EVERY_MS;
      if (due) {
        alertedAt = now();
        page(
          alert,
          "CRITICAL: Oracle cannot obtain its keys from ROFL",
          `No keys after ${attempts} attempts over ${Math.round(waited / 60000)} minutes; ` +
            `the oracle answers nothing until it has them and uses no other key. ` +
            `Last failure: ${described}`,
        );
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(waitMs);
      waitMs = Math.min(waitMs * 2, LONGEST_RETRY_MS);
    }
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Obtains the oracle's keys, waiting for the key service for as long as it takes.
 *
 * @param {object} [options] Everything is injectable for tests.
 * @returns {Promise<Readonly<{
 *   mode: "env" | "rofl",
 *   signingKeyHex: () => string,
 *   signerAddress: string,
 *   decryptor: ReturnType<typeof createDecryptor>,
 * }>>}
 */
async function obtainOracleKeys({
  env = process.env,
  generateKey = rofl.generateKey,
  getAppId = rofl.getAppId,
  sleep = defaultSleep,
  now = Date.now,
  alert = sendAlert,
  log = console,
  appIdTimeoutMs = 2000,
  keyServicePresent = () => fs.existsSync(rofl.DEFAULT_SOCKET_PATH),
} = {}) {
  if (keyModeFor(env.NETWORK_NAME) === "env") return keysFromEnv(env, log, keyServicePresent);

  return keysFromRofl({ env, generateKey, getAppId, appIdTimeoutMs, sleep, now, alert, log });
}

module.exports = { CHAIN_IDS, createDecryptor, keyIdsFor, keyModeFor, obtainOracleKeys };
