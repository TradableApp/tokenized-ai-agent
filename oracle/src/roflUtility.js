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

/**
 * Fetches a key from the ROFL appd.
 * @param {string} id
 * @param {string} [socketPath]
 * @returns {Promise<string>}
 */
async function fetchKey(id, socketPath = "/run/rofl-appd.sock") {
  console.log(`Using unix domain socket: ${socketPath}`);
  const payload = {
    key_id: id,
    kind: "secp256k1",
  };
  console.log(`  Posting ${JSON.stringify(payload)} to /rofl/v1/keys/generate`);
  const response = await appdPost("/rofl/v1/keys/generate", payload, socketPath);
  return response.key;
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
    encrypt: true,
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
  fetchKey,
  submitTx,
};
