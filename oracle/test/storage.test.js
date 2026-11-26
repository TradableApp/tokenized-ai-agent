"use strict";

const chai = require("chai");
const sinon = require("sinon");
const { expect } = chai;
const proxyquire = require("proxyquire");

describe("storage router", function () {
  let storage;
  let arweaveStub;
  let autonomysStub;
  let mirrorStub;

  beforeEach(() => {
    arweaveStub = {
      initializeIrys: sinon.stub().resolves(),
      uploadData: sinon.stub().resolves("arweave_cid_123"),
      fetchData: sinon.stub().resolves("arweave_data"),
      queryTransactionByTags: sinon.stub().resolves("arweave_tx_id"),
    };

    autonomysStub = {
      initializeAutoDrive: sinon.stub().resolves(),
      uploadData: sinon.stub().resolves("autonomys_cid_123"),
      fetchData: sinon.stub().resolves("autonomys_data"),
      queryTransactionByTags: sinon.stub().resolves("autonomys_tx_id"),
    };

    mirrorStub = {
      mirrorInBackground: sinon.stub().returns(new Promise(() => {})),
    };

    storage = proxyquire("../src/storage/storage", {
      "./arweave": arweaveStub,
      "./autonomys": autonomysStub,
      "./mirror": mirrorStub,
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe("initializeStorage", () => {
    it("should call the initializer for all configured providers", async () => {
      await storage.initializeStorage();
      expect(arweaveStub.initializeIrys.calledOnce).to.be.true;
      expect(autonomysStub.initializeAutoDrive.calledOnce).to.be.true;
    });
  });

  describe("uploadData", () => {
    it("should route the upload to the primary provider (autonomys)", async () => {
      const buffer = Buffer.from("test data");
      const tags = [{ name: "Test-Tag", value: "true" }];

      const cid = await storage.uploadData(buffer, tags);

      expect(autonomysStub.uploadData.calledOnce).to.be.true;
      const [sentBuffer, sentTags] = autonomysStub.uploadData.firstCall.args;
      expect(sentBuffer).to.equal(buffer);
      expect(sentTags).to.deep.include(tags[0]);
      expect(cid).to.equal("autonomys_cid_123");
    });

    it("pins a File-Name tag so the Auto Drive CID can be recomputed later", async () => {
      await storage.uploadData(Buffer.from("x"), []);

      const sentTags = autonomysStub.uploadData.firstCall.args[1];
      const fileNameTag = sentTags.find((t) => t.name === "File-Name");
      expect(fileNameTag).to.exist;
      expect(fileNameTag.value).to.match(/^file-\d+\.json$/);
    });

    it("keeps a caller-supplied File-Name tag untouched", async () => {
      const tags = [{ name: "File-Name", value: "rofl-key.txt" }];

      await storage.uploadData(Buffer.from("x"), tags);

      const sentTags = autonomysStub.uploadData.firstCall.args[1];
      expect(sentTags.filter((t) => t.name === "File-Name")).to.deep.equal(tags);
    });

    it("mirrors the uploaded bytes under the returned CID with the Auto Drive file name", async () => {
      const buffer = Buffer.from("ciphertext");
      const tags = [{ name: "File-Name", value: "answer.json" }];

      await storage.uploadData(buffer, tags);

      expect(mirrorStub.mirrorInBackground.calledOnce).to.be.true;
      const [cid, bytes, fileName] = mirrorStub.mirrorInBackground.firstCall.args;
      expect(cid).to.equal("autonomys_cid_123");
      expect(bytes).to.equal(buffer);
      expect(fileName).to.equal("answer.json");
    });

    it("returns the CID without waiting for the mirror (never on the prompt's critical path)", async () => {
      // mirrorInBackground is stubbed to a promise that NEVER resolves; uploadData must still resolve.
      const cid = await storage.uploadData(Buffer.from("x"), []);

      expect(cid).to.equal("autonomys_cid_123");
    });

    it("does not mirror when STORAGE_PROVIDER=irys routes the upload to Arweave", async () => {
      process.env.STORAGE_PROVIDER = "irys";
      try {
        const cid = await storage.uploadData(Buffer.from("x"), []);

        expect(cid).to.equal("arweave_cid_123");
        expect(mirrorStub.mirrorInBackground.called).to.be.false;
      } finally {
        delete process.env.STORAGE_PROVIDER;
      }
    });
  });

  describe("uploadData refuses a file it would later refuse to read", () => {
    const { LARGEST_WRITTEN_FILE_BYTES } = require("../src/storage/storedFileFetch");
    const { isRetryableError, isBadInputError } = require("../src/errors");

    it("uploads a file of exactly the largest written size", async () => {
      await storage.uploadData(Buffer.alloc(LARGEST_WRITTEN_FILE_BYTES, 0x41));

      expect(autonomysStub.uploadData.calledOnce).to.equal(true);
    });

    it("refuses one byte more before any provider is asked, as retryable and not as bad input", async () => {
      let refused;
      try {
        await storage.uploadData(Buffer.alloc(LARGEST_WRITTEN_FILE_BYTES + 1, 0x41));
      } catch (error) {
        refused = error;
      }

      expect(refused, "refused").to.be.an("error");
      expect(refused.name).to.equal("StoredFileWriteRefusedError");
      expect(isRetryableError(refused)).to.equal(true);
      expect(isBadInputError(refused)).to.equal(false);
      expect(autonomysStub.uploadData.called).to.equal(false);
      expect(arweaveStub.uploadData.called).to.equal(false);
      expect(mirrorStub.mirrorInBackground.called).to.equal(false);
    });
  });

  describe("fetchData", () => {
    it("should correctly route to the arweave provider for a valid Arweave CID", async () => {
      // Exactly 43 chars, valid Base64URL characters
      const arweaveCid = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v";
      const data = await storage.fetchData(arweaveCid);

      expect(arweaveStub.fetchData.calledOnceWith(arweaveCid)).to.be.true;
      expect(data).to.equal("arweave_data");
    });

    it("should throw an error for an unsupported CID format, without repeating it", async () => {
      const invalidCid = "this-is-not-a-valid-cid";
      try {
        await storage.fetchData(invalidCid);
        expect.fail("fetchData should have thrown an error for an invalid CID");
      } catch (error) {
        expect(error.message).to.include("Unsupported content id");
        expect(error.message).to.not.include(invalidCid);
      }
    });

    it("fetches nothing for an id that is not a content id, and prints none of it", async () => {
      const forged = `${"A".repeat(43)}\n[Oracle] forged line`;
      const printed = [];
      sinon.stub(console, "log").callsFake((...args) => printed.push(args.join(" ")));
      sinon.stub(console, "warn").callsFake((...args) => printed.push(args.join(" ")));
      sinon.stub(console, "error").callsFake((...args) => printed.push(args.join(" ")));

      let refused;
      try {
        await storage.fetchData(forged);
      } catch (error) {
        refused = error;
      }

      expect(refused, "refused").to.be.an("error");
      expect(refused.message).to.not.include("forged line");
      expect(arweaveStub.fetchData.called).to.equal(false);
      expect(autonomysStub.fetchData.called).to.equal(false);
      expect(printed.join("\n")).to.not.include("forged line");
    });

    it("routes an Autonomys id to Auto Drive and passes the fetch limits on", async () => {
      const autonomysCid = `bafkr6i${"a".repeat(52)}`;
      const limits = { maxBytes: 1024, timeoutMs: 500 };

      const data = await storage.fetchData(autonomysCid, limits);

      expect(autonomysStub.fetchData.calledOnceWith(autonomysCid, limits)).to.equal(true);
      expect(data).to.equal("autonomys_data");
    });
  });

  describe("queryTransactionByTags", () => {
    it("should route the query to the primary provider (autonomys)", async () => {
      const tags = [{ name: "Content-Type", value: "application/json" }];
      const txId = await storage.queryTransactionByTags(tags);

      expect(autonomysStub.queryTransactionByTags.calledOnceWith(tags)).to.be.true;
      expect(txId).to.equal("autonomys_tx_id");
    });
  });
});

describe("storage router — local IPFS mode (LOCAL_IPFS_API_URL set)", function () {
  let storage;
  let ipfsStub;
  let arweaveStub;
  let autonomysStub;
  let mirrorStub;

  beforeEach(() => {
    // The mode flags are read at module load, so set the env before proxyquire.
    process.env.LOCAL_IPFS_API_URL = "http://localhost:5001";

    ipfsStub = {
      initialize: sinon.stub().resolves(),
      uploadData: sinon
        .stub()
        .resolves("bafkreilocalaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
      fetchData: sinon.stub().resolves("ipfs_data"),
    };
    arweaveStub = { initializeIrys: sinon.stub().resolves() };
    autonomysStub = { initializeAutoDrive: sinon.stub().resolves() };

    mirrorStub = { mirrorInBackground: sinon.stub().returns(new Promise(() => {})) };

    storage = proxyquire("../src/storage/storage", {
      "./ipfs": ipfsStub,
      "./arweave": arweaveStub,
      "./autonomys": autonomysStub,
      "./mirror": mirrorStub,
    });
  });

  afterEach(() => {
    delete process.env.LOCAL_IPFS_API_URL;
    sinon.restore();
  });

  it("uploadData never mirrors in local IPFS mode", async () => {
    await storage.uploadData(Buffer.from("x"), []);

    expect(mirrorStub.mirrorInBackground.called).to.be.false;
  });

  it("initializeStorage initialises only the local IPFS provider", async () => {
    await storage.initializeStorage();
    expect(ipfsStub.initialize.calledOnceWith("http://localhost:5001")).to.be.true;
    expect(autonomysStub.initializeAutoDrive.called).to.be.false;
    expect(arweaveStub.initializeIrys.called).to.be.false;
  });

  it("uploadData routes to IPFS and indexes tags for queryTransactionByTags", async () => {
    const buffer = Buffer.from("answer payload");
    const tags = [{ name: "Conversation-Id", value: "1" }];

    const cid = await storage.uploadData(buffer, tags);
    expect(ipfsStub.uploadData.calledOnceWith(buffer, tags)).to.be.true;
    expect(cid).to.equal("bafkreilocalaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

    // The in-memory tag index now resolves the just-uploaded CID (IPFS itself
    // has no tag query — this is what keeps session-key lookup working).
    const found = await storage.queryTransactionByTags(tags);
    expect(found).to.equal("bafkreilocalaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("fetchData routes to the local IPFS provider", async () => {
    const data = await storage.fetchData(
      "bafkreilocalaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(
      ipfsStub.fetchData.calledOnceWith(
        "bafkreilocalaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ),
    ).to.be.true;
    expect(data).to.equal("ipfs_data");
  });

  it("queryTransactionByTags returns null when nothing matches", async () => {
    const found = await storage.queryTransactionByTags([{ name: "Nope", value: "x" }]);
    expect(found).to.equal(null);
  });
});
