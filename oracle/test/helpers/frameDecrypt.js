const crypto = require("crypto");

/**
 * Test-only reader of a stream frame: the same steps the dApp's `decryptData` takes (base64 IV,
 * a dot, base64 ciphertext with the 16-byte GCM tag appended; JSON plaintext). Kept apart from
 * the oracle's own decryptor on purpose, so a test that decrypts frames checks the format and
 * not the oracle's reading of it.
 */
function decryptFrame(ciphertext, key) {
  const [ivB64, bodyB64] = ciphertext.split(".");
  const iv = Buffer.from(ivB64, "base64");
  const body = Buffer.from(bodyB64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(body.subarray(body.length - 16));
  const plain = Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]);
  return JSON.parse(plain.toString("utf-8"));
}

module.exports = { decryptFrame };
