const crypto = require("crypto");

const GCM_IV_BYTES = 12;
const GCM_AUTH_TAG_BYTES = 16;

const randomIv = () => crypto.randomBytes(GCM_IV_BYTES);

/**
 * Symmetrically encrypts a data object using AES-256-GCM.
 *
 * The one encryptor for everything the oracle seals with a prompt's session key: the stored
 * MessageFiles and the live reasoning frames. The output is what the dApp's `decryptData` reads:
 * `base64(iv) + "." + base64(ciphertext ‖ tag)`, the tag appended to match Web Crypto.
 *
 * @param {object} dataObject The object to encrypt (serialised with JSON.stringify).
 * @param {Buffer} key The 32-byte symmetric key.
 * @param {() => Buffer} [ivSource] Gives the 12-byte IV. Only the shared test vector passes one;
 *   every real caller takes the default, a fresh random IV per call.
 * @returns {string} "iv.encryptedData" in base64.
 */
function encryptSymmetrically(dataObject, key, ivSource = randomIv) {
  const iv = ivSource();
  if (!Buffer.isBuffer(iv) || iv.length !== GCM_IV_BYTES) {
    throw new TypeError(`AES-GCM needs a ${GCM_IV_BYTES}-byte IV.`);
  }
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const dataBuffer = Buffer.from(JSON.stringify(dataObject));

  const encryptedContent = Buffer.concat([cipher.update(dataBuffer), cipher.final()]);
  const combinedBuffer = Buffer.concat([encryptedContent, cipher.getAuthTag()]);

  return `${iv.toString("base64")}.${combinedBuffer.toString("base64")}`;
}

module.exports = { encryptSymmetrically, GCM_IV_BYTES, GCM_AUTH_TAG_BYTES };
