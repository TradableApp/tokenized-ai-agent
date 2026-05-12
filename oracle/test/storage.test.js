'use strict';

const chai = require("chai");
const sinon = require("sinon");
const { expect } = chai;
const proxyquire = require("proxyquire");

describe("storage router", function () {
  let storage;
  let arweaveStub;
  let autonomysStub;

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

    storage = proxyquire("../src/storage/storage", {
      "./arweave": arweaveStub,
      "./autonomys": autonomysStub,
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

      expect(autonomysStub.uploadData.calledOnceWith(buffer, tags)).to.be.true;
      expect(cid).to.equal("autonomys_cid_123");
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

    it("should throw an error for an unsupported CID format", async () => {
      const invalidCid = "this-is-not-a-valid-cid";
      try {
        await storage.fetchData(invalidCid);
        expect.fail("fetchData should have thrown an error for an invalid CID");
      } catch (error) {
        expect(error.message).to.equal(`Unsupported CID format: ${invalidCid}`);
      }
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
