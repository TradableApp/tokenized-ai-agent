const chai = require("chai");
const sinon = require("sinon");
const { expect } = chai;
const proxyquire = require("proxyquire");

describe("storage router", function () {
  let storage;
  let arweaveStub;

  beforeEach(() => {
    // Create a mock for our arweave storage module
    arweaveStub = {
      initializeIrys: sinon.stub().resolves(),
      uploadData: sinon.stub().resolves("arweave_cid_123"),
      fetchData: sinon.stub().resolves("arweave_data"),
      queryTransactionByTags: sinon.stub().resolves("arweave_tx_id"),
    };

    // Use proxyquire to load the storage module, replacing the real arweave module with our mock
    storage = proxyquire("../src/storage/storage", {
      "./arweave": arweaveStub,
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe("initializeStorage", () => {
    it("should call the initializer for all configured providers", async () => {
      await storage.initializeStorage();
      expect(arweaveStub.initializeIrys.calledOnce).to.be.true;
      // When you add another provider, you would add an expectation for it here.
    });
  });

  describe("uploadData", () => {
    it("should route the upload to the primary provider (arweave)", async () => {
      const buffer = Buffer.from("test data");
      const tags = [{ name: "Test-Tag", value: "true" }];

      const cid = await storage.uploadData(buffer, tags);

      // Assert that the arweave module was called with the correct data
      expect(arweaveStub.uploadData.calledOnceWith(buffer, tags)).to.be.true;
      // Assert that the final CID is the one returned by the arweave module
      expect(cid).to.equal("arweave_cid_123");
    });
  });

  describe("fetchData", () => {
    it("should correctly route to the arweave provider for a valid Arweave CID", async () => {
      // This string is exactly 43 characters and uses valid Base64URL characters.
      const arweaveCid = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v";
      const data = await storage.fetchData(arweaveCid);

      // Assert that the arweave module's fetch was called
      expect(arweaveStub.fetchData.calledOnceWith(arweaveCid)).to.be.true;
      // Assert that we get back the data from the arweave module
      expect(data).to.equal("arweave_data");
    });

    it("should throw an error for an unsupported CID format", async () => {
      const invalidCid = "this-is-not-a-valid-cid";
      try {
        await storage.fetchData(invalidCid);
        // If it doesn't throw, fail the test
        expect.fail("fetchData should have thrown an error for an invalid CID");
      } catch (error) {
        expect(error.message).to.equal(`Unsupported CID format: ${invalidCid}`);
      }
    });
  });

  describe("queryTransactionByTags", () => {
    it("should route the query to the primary provider (arweave)", async () => {
      const tags = [{ name: "Content-Type", value: "application/json" }];
      const txId = await storage.queryTransactionByTags(tags);

      // Assert that the arweave module's query function was called
      expect(arweaveStub.queryTransactionByTags.calledOnceWith(tags)).to.be.true;
      expect(txId).to.equal("arweave_tx_id");
    });
  });
});
