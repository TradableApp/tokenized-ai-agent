const http = require("http");
const net = require("net");
const { URL } = require("url");

/**
 * Helper to POST to the ROFL appd UNIX socket.
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
          const json = JSON.parse(responseData);
          resolve(json);
        } catch (e) {
          reject(new Error(`Invalid JSON: ${responseData}`));
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
 * @returns {Promise<any>}
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
  return await appdPost("/rofl/v1/tx/sign-submit", payload, socketPath);
}

module.exports = {
  fetchKey,
  submitTx,
};
