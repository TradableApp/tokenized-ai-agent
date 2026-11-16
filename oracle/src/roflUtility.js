const cbor = require("cbor");
const http = require("http");
const net = require("net");
const { URL } = require("url");

/**
 * Helper to POST to the ROFL appd UNIX socket.
 * This version can handle both JSON and CBOR-encoded hex responses.
 * @param {string} path
 * @param {Object} payload
 * @param {string} [socketPath]
 * @returns {Promise<any>}
 */
function appdPost(path, payload, socketPath = "/run/rofl-appd.sock") {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const options = {
      socketPath,
      path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = http.request(options, (res) => {
      let responseData = "";
      res.on("data", (chunk) => {
        responseData += chunk;
      });
      res.on("end", () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`Status ${res.statusCode}: ${responseData}`));
        }
        try {
          // First, try to parse as plain JSON.
          const json = JSON.parse(responseData);
          resolve(json);
        } catch (jsonError) {
          // If JSON parsing fails, it's likely a CBOR-encoded hex string.
          try {
            const decodedCbor = cbor.decodeFirstSync(Buffer.from(responseData, "hex"));
            resolve(decodedCbor);
          } catch (cborError) {
            reject(new Error(`Invalid response: Not valid JSON or CBOR. Raw: ${responseData}`));
          }
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

const DEFAULT_SOCKET_PATH = "/run/rofl-appd.sock";
const KEY_HEX = /^(?:0x)?[0-9a-fA-F]{64}$/;
const APPD_TIMEOUT_MS = 10 * 1000;
// A key or an app id is a few dozen bytes.
const APPD_LONGEST_ANSWER = 64 * 1024;

/**
 * One request to the ROFL appd socket whose answer is never repeated: not in a log line and
 * not in an error. What the key service returns is a key, and an error that quoted it would
 * carry it to the machine's logs.
 *
 * @returns {Promise<string>} The response body.
 */
function appdQuiet(method, path, payload, socketPath, timeoutMs = APPD_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? null : JSON.stringify(payload);
    const headers =
      body === null
        ? {}
        : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) };
    const req = http.request({ socketPath, path, method, headers }, (res) => {
      const chunks = [];
      let received = 0;
      res.on("data", (chunk) => {
        received += chunk.length;
        if (received > APPD_LONGEST_ANSWER) {
          req.destroy(new Error("The ROFL key service's answer is too large"));

          return;
        }
        chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => {
        const answer = Buffer.concat(chunks);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const error = new Error(
            `The ROFL key service answered ${res.statusCode} (${answer.length} bytes)`,
          );
          error.status = res.statusCode;

          return reject(error);
        }
        resolve(answer.toString("utf8"));
      });
    });
    // A socket that takes the request and says nothing would otherwise be waited on for ever,
    // with nothing failing and so nothing to retry or alert on.
    req.setTimeout(timeoutMs, () =>
      req.destroy(new Error(`The ROFL key service did not answer within ${timeoutMs} ms`)),
    );
    req.on("error", reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

/**
 * Asks the ROFL key service for a key. The same app and the same id always give the same key,
 * on any machine of the app, and the key never exists outside the TEE.
 *
 * @param {string} keyId
 * @param {string} [kind]
 * @param {string} [socketPath]
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<Uint8Array>} The 32 bytes of the key.
 */
async function generateKey(
  keyId,
  kind = "secp256k1",
  socketPath = DEFAULT_SOCKET_PATH,
  { timeoutMs } = {},
) {
  const answer = await appdQuiet(
    "POST",
    "/rofl/v1/keys/generate",
    { key_id: keyId, kind },
    socketPath,
    timeoutMs,
  );
  let key;
  try {
    ({ key } = JSON.parse(answer));
  } catch {
    key = undefined;
  }
  if (typeof key !== "string" || !KEY_HEX.test(key)) {
    throw new Error(
      `The ROFL key service's answer is not a 32-byte key (${answer.length} bytes received)`,
    );
  }

  return new Uint8Array(Buffer.from(key.replace(/^0x/i, ""), "hex"));
}

/**
 * The id of the ROFL app this machine runs under. Public.
 * @param {string} [socketPath]
 * @returns {Promise<string>}
 */
async function getAppId(socketPath = DEFAULT_SOCKET_PATH) {
  const answer = (await appdQuiet("GET", "/rofl/v1/app/id", undefined, socketPath)).trim();

  // Plain text today; a quoted string would be the same id.
  return answer.replace(/^"|"$/g, "");
}

/**
 * Submits a transaction to the ROFL appd.
 * @param {Object} tx
 * @param {string} [socketPath]
 * @returns {Promise<string>} The transaction hash.
 */
async function submitTx(tx, socketPath = "/run/rofl-appd.sock") {
  console.log(`Using unix domain socket: ${socketPath}`);
  const payload = {
    tx: {
      kind: "eth",
      data: {
        gas_limit: tx.gas,
        to: tx.to.replace(/^0x/, ""),
        value: tx.value,
        data: tx.data.replace(/^0x/, ""),
      },
    },
    encrypt: false,
  };
  console.log(`  Posting ${JSON.stringify(payload)} to /rofl/v1/tx/sign-submit`);

  const response = await appdPost("/rofl/v1/tx/sign-submit", payload, socketPath);

  // The ROFL API may return the hash in `tx_hash` or `data`.
  // The decoded error will have a `message` field.
  if (response.tx_hash) {
    return response.tx_hash;
  }
  if (response.data) {
    return response.data;
  }
  if (response.message) {
    // This is a decoded CBOR error.
    throw new Error(`Transaction reverted: ${response.message}`);
  }

  throw new Error(
    "Transaction response did not contain 'tx_hash', 'data', or a decoded error message.",
  );
}

module.exports = {
  DEFAULT_SOCKET_PATH,
  generateKey,
  getAppId,
  submitTx,
};
