const chai = require("chai");
const sinon = require("sinon");
const { expect } = chai;
const proxyquire = require("proxyquire");

describe("arweave storage utility", function () {
  let arweaveModule;
  let stubs;
  let irysUploaderStub;

  beforeEach(() => {
    // Keep a reference to original env vars to restore them
    this.originalEnv = { ...process.env };

    // Create a detailed mock of the Irys uploader object
    irysUploaderStub = {
      getBalance: sinon.stub().resolves("100000000000000000"), // 0.1 ETH
      fund: sinon.stub().resolves({ tx_id: "fake_tx" }),
      upload: sinon.stub().resolves({ id: "arweave_cid_123" }),
      getPrice: sinon.stub().resolves({ isGreaterThan: () => false }),
      utils: {
        fromAtomic: sinon.stub().callsFake((val) => parseFloat(val) / 1e18),
        toAtomic: sinon.stub().callsFake((val) => val * 1e18),
      },
      token: "ETH",
    };

    // Mock the Irys library's builder pattern
    const irysUploaderBuilder = {
      withWallet: sinon.stub().returnsThis(),
      withRpc: sinon.stub().returnsThis(),
      devnet: sinon.stub().resolves(irysUploaderStub),
    };

    stubs = {
      "@irys/upload": {
        Uploader: sinon.stub().returns(irysUploaderBuilder),
        BaseEth: {},
      },
      "../alerting": {
        sendAlert: sinon.stub().resolves(),
      },
      "node-fetch": sinon.stub().resolves({
        ok: true,
        text: () => Promise.resolve("some data"),
        json: () =>
          Promise.resolve({
            data: { transactions: { edges: [{ node: { id: "gql_tx_id" } }] } },
          }),
      }),
    };

    // Load the arweave module with our stubs
    arweaveModule = proxyquire("../src/storage/arweave", stubs);

    // Set default env vars needed for initialization
    process.env.IRYS_PAYMENT_PRIVATE_KEY = "mock_key";
    process.env.IRYS_NETWORK = "devnet";
    process.env.IRYS_PAYMENT_RPC_URL = "mock_rpc";
  });

  afterEach(() => {
    sinon.restore();
    // Restore original environment
    process.env = this.originalEnv;
  });

  describe("initializeIrys", () => {
    it("should throw an error if environment variables are missing", async () => {
      delete process.env.IRYS_PAYMENT_PRIVATE_KEY;
      try {
        await arweaveModule.initializeIrys();
        expect.fail("Should have thrown an error");
      } catch (error) {
        expect(error.message).to.include("Missing required Irys environment variables");
      }
    });

    it("should fund the wallet if the balance is below the threshold", async () => {
      process.env.IRYS_BALANCE_ALERT_THRESHOLD = "0.2"; // 0.2 ETH
      // Simulate a low balance (0.1 ETH)
      irysUploaderStub.getBalance.resolves("100000000000000000");

      await arweaveModule.initializeIrys();

      expect(
        stubs["../alerting"].sendAlert.calledWith(
          "Irys Wallet Balance Low - Auto-Funding Initiated",
        ),
      ).to.be.true;
      expect(irysUploaderStub.fund.calledOnce).to.be.true;
    });

    it("should NOT fund the wallet if the balance is sufficient", async () => {
      process.env.IRYS_BALANCE_ALERT_THRESHOLD = "0.05"; // 0.05 ETH
      // Simulate a high balance (0.1 ETH)
      irysUploaderStub.getBalance.resolves("100000000000000000");

      await arweaveModule.initializeIrys();

      expect(stubs["../alerting"].sendAlert.called).to.be.false;
      expect(irysUploaderStub.fund.called).to.be.false;
    });

    it("should send a critical alert if funding the wallet fails", async () => {
      process.env.IRYS_BALANCE_ALERT_THRESHOLD = "0.2"; // Force funding attempt
      irysUploaderStub.getBalance.resolves("100000000000000000"); // Low balance

      const fundingError = new Error("Blockchain congestion");
      irysUploaderStub.fund.rejects(fundingError); // Simulate a funding failure

      try {
        await arweaveModule.initializeIrys();
        expect.fail("Should have thrown an error after failed funding");
      } catch (error) {
        expect(error.message).to.include("The oracle failed to fund its Irys balance");
        expect(stubs["../alerting"].sendAlert.calledWith("CRITICAL: Irys Auto-Funding FAILED")).to
          .be.true;
      }
    });
  });

  describe("uploadData", () => {
    it("should upload data and return a receipt ID on success", async () => {
      await arweaveModule.initializeIrys();
      const data = Buffer.from("test data");
      const tags = [{ name: "Test", value: "true" }];
      const cid = await arweaveModule.uploadData(data, tags);

      expect(irysUploaderStub.upload.calledOnceWith(data, { tags })).to.be.true;
      expect(cid).to.equal("arweave_cid_123");
    });

    it("should send a critical alert if the upload fails", async () => {
      const uploadError = new Error("Network timeout");
      irysUploaderStub.upload.rejects(uploadError);

      await arweaveModule.initializeIrys();
      try {
        await arweaveModule.uploadData(Buffer.from("test"));
        expect.fail("Upload should have thrown an error");
      } catch (error) {
        expect(error).to.equal(uploadError);
        expect(stubs["../alerting"].sendAlert.calledOnceWith("CRITICAL: Irys Upload Failed")).to.be
          .true;
      }
    });
  });

  describe("fetchData and queryTransactionByTags", () => {
    it("fetchData should call the correct gateway URL", async () => {
      const cid = "some_arweave_cid";
      await arweaveModule.fetchData(cid);
      expect(stubs["node-fetch"].calledOnceWith(`https://gateway.irys.xyz/${cid}`)).to.be.true;
    });

    it("queryTransactionByTags should send a correctly formatted GQL query", async () => {
      const tags = [{ name: "Content-Type", value: "application/json" }];
      await arweaveModule.queryTransactionByTags(tags);
      const fetchCall = stubs["node-fetch"].firstCall.args;
      const body = JSON.parse(fetchCall[1].body);

      expect(fetchCall[0]).to.equal("https://uploader.irys.xyz/graphql");
      expect(body.query).to.include(`name: "${tags[0].name}"`);
      expect(body.query).to.include(`values: ["${tags[0].value}"]`);
    });
  });
});
