"use strict";

const chai = require("chai");
const sinon = require("sinon");
const { expect } = chai;

const ipfs = require("../src/storage/ipfs");

describe("local IPFS provider (ipfs.js)", function () {
  afterEach(() => sinon.restore());

  it("initialize verifies connectivity via POST /api/v0/version", async () => {
    const fetchStub = sinon
      .stub(global, "fetch")
      .resolves({ ok: true, json: async () => ({ Version: "0.17.0" }) });

    await ipfs.initialize("http://localhost:5001/"); // trailing slash trimmed

    expect(fetchStub.calledOnce).to.be.true;
    expect(fetchStub.firstCall.args[0]).to.equal("http://localhost:5001/api/v0/version");
    expect(fetchStub.firstCall.args[1]).to.deep.include({ method: "POST" });
  });

  it("uploadData posts to /api/v0/add (cid-version=1) and returns the CIDv1", async () => {
    sinon.stub(global, "fetch").callsFake(async (url) => {
      if (url.endsWith("/api/v0/version")) {
        return { ok: true, json: async () => ({ Version: "0.17.0" }) };
      }
      expect(url).to.contain("/api/v0/add");
      expect(url).to.contain("cid-version=1");
      // Kubo returns newline-delimited JSON; last line is the added file.
      return { ok: true, text: async () => '{"Name":"f","Hash":"bafkreiabc","Size":"9"}\n' };
    });

    await ipfs.initialize("http://localhost:5001");
    const cid = await ipfs.uploadData(Buffer.from("ciphertext"), [{ name: "X", value: "1" }]);

    expect(cid).to.equal("bafkreiabc");
  });

  it("fetchData cats the CID and returns the content as a string", async () => {
    sinon.stub(global, "fetch").callsFake(async (url) => {
      if (url.endsWith("/api/v0/version")) {
        return { ok: true, json: async () => ({ Version: "0.17.0" }) };
      }
      expect(url).to.contain("/api/v0/cat?arg=bafkreiabc");
      return { ok: true, text: async () => "decrypted-elsewhere-ciphertext" };
    });

    await ipfs.initialize("http://localhost:5001");
    const data = await ipfs.fetchData("bafkreiabc");

    expect(data).to.equal("decrypted-elsewhere-ciphertext");
  });

  it("round-trips a payload (add then cat) byte-for-byte", async () => {
    const payload = "u2FsdGVkX1+abc/def=="; // base64-ish ciphertext string
    let stored = null;
    sinon.stub(global, "fetch").callsFake(async (url, opts) => {
      if (url.endsWith("/api/v0/version")) {
        return { ok: true, json: async () => ({ Version: "0.17.0" }) };
      }
      if (url.includes("/api/v0/add")) {
        stored = await opts.body.get("file").text();
        return { ok: true, text: async () => '{"Name":"f","Hash":"bafkreiround","Size":"1"}' };
      }
      // cat returns what was stored
      return { ok: true, text: async () => stored };
    });

    await ipfs.initialize("http://localhost:5001");
    const cid = await ipfs.uploadData(Buffer.from(payload), []);
    const back = await ipfs.fetchData(cid);

    expect(cid).to.equal("bafkreiround");
    expect(back).to.equal(payload);
  });

  it("throws a clear error when Kubo is unreachable", async () => {
    sinon
      .stub(global, "fetch")
      .resolves({ ok: false, status: 502, text: async () => "bad gateway" });
    try {
      await ipfs.initialize("http://localhost:5001");
      expect.fail("initialize should have thrown");
    } catch (e) {
      expect(e.message).to.contain("not reachable");
    }
  });
});
