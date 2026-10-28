const { expect } = require("chai");
const crypto = require("node:crypto");

const { aesGcmEncrypt, aesGcmDecrypt, gatewayUrl } = require("../scripts/smoke/wire.js");

describe("smoke: wire format", () => {
  it("round-trips a MessageFile through the dApp's iv.ct encoding", () => {
    const key = crypto.randomBytes(32);
    const file = { role: "assistant", content: "Bitcoin is up 2%." };
    expect(aesGcmDecrypt(key, aesGcmEncrypt(key, file))).to.deep.equal(file);
  });

  it("names a stored value without the iv.ct separator instead of a Buffer TypeError", () => {
    expect(() => aesGcmDecrypt(crypto.randomBytes(32), "not-ciphertext")).to.throw(
      /iv\.ct.*no separator/,
    );
  });

  it("routes CIDs to the right gateway and refuses an unknown shape", () => {
    expect(gatewayUrl("bafkr6iabc")).to.match(
      /^https:\/\/gateway\.autonomys\.xyz\/file\/bafkr6iabc$/,
    );
    expect(gatewayUrl("A".repeat(43))).to.match(/^https:\/\/gateway\.irys\.xyz\//);
    expect(gatewayUrl("bafyabc", { storageGatewayUrl: "http://localhost:8080/ipfs/" })).to.equal(
      "http://localhost:8080/ipfs/bafyabc",
    );
    expect(() => gatewayUrl("bafyabc")).to.throw(/Unrecognised CID/);
  });
});
