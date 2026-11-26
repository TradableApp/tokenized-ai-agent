const { expect } = require("chai");
const crypto = require("crypto");

const { eciesEncrypt } = require("../src/ecies");
const { BadInputError } = require("../src/errors");
const { createDecryptor } = require("../src/oracleKeys");
const { unwrapSessionKey, payloadText } = require("../src/userCiphertext");

// What a prompt's sender controls, read with the oracle's own healthy key: the wrapped session
// key and the payload bytes. Anything wrong with them is bad input. A failure that is the
// oracle's own (its runtime, its memory) is passed on as it is.
describe("ciphertext a user sends", () => {
  const decryptor = createDecryptor(Uint8Array.from(crypto.randomBytes(32)));
  const wrap = (key) => eciesEncrypt(decryptor.publicKey, key);

  async function refusal(promise) {
    try {
      await promise;
    } catch (error) {
      return error;
    }
    throw new Error("expected a refusal");
  }

  describe("unwrapSessionKey", () => {
    it("gives back the 32-byte session key a well-formed wrap holds", async () => {
      const sessionKey = crypto.randomBytes(32);

      const unwrapped = await unwrapSessionKey(decryptor, await wrap(sessionKey));

      expect(Buffer.compare(unwrapped, sessionKey)).to.equal(0);
    });

    it("refuses a wrap whose version byte is not 1 as bad input", async () => {
      const blob = await wrap(crypto.randomBytes(32));
      blob[0] = 0x02;

      expect(await refusal(unwrapSessionKey(decryptor, blob))).to.be.instanceOf(BadInputError);
    });

    it("refuses a wrap too short to hold a key as bad input", async () => {
      const blob = Buffer.concat([Buffer.from([0x01]), crypto.randomBytes(92)]);

      expect(await refusal(unwrapSessionKey(decryptor, blob))).to.be.instanceOf(BadInputError);
    });

    it("refuses a wrap whose public key is not a point on the curve as bad input", async () => {
      const notAPoint = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 0xff)]);
      const blob = Buffer.concat([Buffer.from([0x01]), notAPoint, crypto.randomBytes(12 + 48)]);

      expect(await refusal(unwrapSessionKey(decryptor, blob))).to.be.instanceOf(BadInputError);
    });

    it("refuses a wrap whose authentication tag does not match as bad input", async () => {
      const blob = await wrap(crypto.randomBytes(32));
      blob[blob.length - 1] ^= 0x01;

      expect(await refusal(unwrapSessionKey(decryptor, blob))).to.be.instanceOf(BadInputError);
    });

    it("refuses a well-formed wrap of a key that is not 32 bytes as bad input", async () => {
      const error = await refusal(unwrapSessionKey(decryptor, await wrap(crypto.randomBytes(16))));

      expect(error).to.be.instanceOf(BadInputError);
      expect(error.message).to.not.match(/[0-9a-f]{32}/i);
    });

    it("passes on a failure that carries a runtime code, which is not the sender's doing", async () => {
      const fault = Object.assign(new Error("binding failed"), { code: "ERR_CRYPTO_OPERATION_FAILED" });
      const failing = { decrypt: () => Promise.reject(fault) };

      expect(await refusal(unwrapSessionKey(failing, Buffer.from([0x01])))).to.equal(fault);
    });

    it("passes on a RangeError, which is an allocation failure", async () => {
      const fault = new RangeError("Array buffer allocation failed");
      const failing = { decrypt: () => Promise.reject(fault) };

      expect(await refusal(unwrapSessionKey(failing, Buffer.from([0x01])))).to.equal(fault);
    });
  });

  describe("payloadText", () => {
    it("reads the payload bytes as UTF-8 text", () => {
      expect(payloadText(new TextEncoder().encode("iv.data"))).to.equal("iv.data");
    });

    it("refuses bytes that are not UTF-8 as bad input, quoting none of them", () => {
      let error;
      try {
        payloadText(Uint8Array.from([0x41, 0xff, 0xfe, 0x42]));
      } catch (caught) {
        error = caught;
      }

      expect(error).to.be.instanceOf(BadInputError);
      expect(error.message).to.not.match(/0x|ff|fe/i);
    });
  });
});
