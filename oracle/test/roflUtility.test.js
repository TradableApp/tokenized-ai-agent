const chai = require("chai");
const sinon = require("sinon");
const { expect, assert } = chai; // Using assert for the fail case
const fs = require("fs");
const http = require("http");
const cbor = require("cbor");
const { fetchKey, submitTx } = require("../src/roflUtility");

describe("roflUtility", function () {
  let server;
  const socketPath = "/tmp/appd_test_socket.sock";

  // Use a variable to control the mock server's response for different tests.
  let mockResponse = {};
  let mockStatusCode = 200;
  let responseIsCbor = false;

  beforeEach((done) => {
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }

    const serverHandler = (req, res) => {
      // For CBOR, the content type would be different, but for this mock, JSON is fine.
      res.writeHead(mockStatusCode, { "Content-Type": "application/json" });
      if (responseIsCbor) {
        // Send raw hex string, as the utility expects
        res.end(mockResponse);
      } else {
        res.end(JSON.stringify(mockResponse));
      }
    };

    server = http.createServer(serverHandler);
    server.listen(socketPath, done);
  });

  afterEach((done) => {
    server.close(() => {
      if (fs.existsSync(socketPath)) {
        fs.unlinkSync(socketPath);
      }
      // Reset mocks after each test.
      mockStatusCode = 200;
      mockResponse = {};
      responseIsCbor = false;
      done();
    });
  });

  describe("fetchKey", function () {
    it("should return a key on success", async () => {
      mockResponse = { key: "test_key" };
      const key = await fetchKey("test_id", socketPath);
      expect(key).to.equal("test_key");
    });

    it("should throw an error if the request fails", async () => {
      try {
        await fetchKey("test_id", "/invalid/socket/path");
        // If the above line does not throw, this test should fail.
        assert.fail("Expected fetchKey to throw but it did not.");
      } catch (error) {
        expect(error).to.be.an("Error");
        expect(error.message).to.include("connect ENOENT /invalid/socket/path");
      }
    });

    it("should throw an error for a non-200 status code", async () => {
      mockStatusCode = 500;
      mockResponse = { error: "Internal Server Error" };
      try {
        await fetchKey("test_id", socketPath);
        assert.fail("Expected fetchKey to throw but it did not.");
      } catch (error) {
        expect(error).to.be.an("Error");
        expect(error.message).to.include("Status 500");
      }
    });
  });

  describe("submitTx", function () {
    const tx = { gas: 100000, to: "0x123", value: 0, data: "0x456" };

    it("should return tx_hash when present in the response", async () => {
      mockResponse = { tx_hash: "0x123abc" };
      const txHash = await submitTx(tx, socketPath);
      expect(txHash).to.equal("0x123abc");
    });

    it("should return data when present in the response", async () => {
      mockResponse = { data: "0x456def" };
      const txHash = await submitTx(tx, socketPath);
      expect(txHash).to.equal("0x456def");
    });

    it("should throw a formatted error for a CBOR revert message", async () => {
      const errorMessage = "Execution reverted: Insufficient funds";
      // The response from appd is a hex-encoded CBOR buffer.
      mockResponse = cbor.encode({ message: errorMessage }).toString("hex");
      responseIsCbor = true; // Tell the mock server to send raw hex.

      try {
        await submitTx(tx, socketPath);
        assert.fail("Expected submitTx to throw but it did not.");
      } catch (error) {
        expect(error).to.be.an("Error");
        expect(error.message).to.equal(`Transaction reverted: ${errorMessage}`);
      }
    });

    it("should throw a generic error if the response is malformed", async () => {
      mockResponse = { unexpected_field: "some_value" };
      try {
        await submitTx(tx, socketPath);
        assert.fail("Expected submitTx to throw but it did not.");
      } catch (error) {
        expect(error).to.be.an("Error");
        expect(error.message).to.equal(
          "Transaction response did not contain 'tx_hash', 'data', or a decoded error message.",
        );
      }
    });

    it("should throw an error if the request fails", async () => {
      try {
        await submitTx(tx, "/invalid/socket/path");
        assert.fail("Expected submitTx to throw but it did not.");
      } catch (error) {
        expect(error).to.be.an("Error");
        expect(error.message).to.include("connect ENOENT /invalid/socket/path");
      }
    });
  });
});
