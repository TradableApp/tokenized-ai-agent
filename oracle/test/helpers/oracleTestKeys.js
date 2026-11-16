const { ethers } = require("ethers");

const { createDecryptor } = require("../../src/oracleKeys");

/**
 * Gives a freshly loaded oracle module its keys, the way index.js does after obtaining them.
 * The key is the test's own PRIVATE_KEY, which is what a local network uses for both purposes.
 *
 * @template T
 * @param {T} oracle The loaded `aiAgentOracle` module.
 * @param {{ eciesDecrypt: Function }} [ecies] A stand-in for the decryption itself, for suites
 *        that stub it and assert on the stub.
 * @returns {T} The same module, configured.
 */
function withTestKeys(oracle, ecies) {
  const privateKey = process.env.PRIVATE_KEY;
  const real = createDecryptor(ethers.getBytes(privateKey));
  const decryptor = ecies
    ? Object.freeze({
        ...real,
        decrypt: (cipherBlob) => ecies.eciesDecrypt(privateKey, cipherBlob),
      })
    : real;
  oracle.configure({ mode: "env", signingKeyHex: () => privateKey, decryptor });

  return oracle;
}

module.exports = { withTestKeys };
