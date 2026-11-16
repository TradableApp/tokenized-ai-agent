const chai = require("chai");
const sinon = require("sinon");
const { expect, assert } = chai; // Using assert for the fail case
const fs = require("fs");
const http = require("http");
const cbor = require("cbor");
const roflUtility = require("../src/roflUtility");

const { generateKey, getAppId, submitTx } = roflUtility;

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

  describe("generateKey", function () {
    const KEY = "ab".repeat(32);
    let lastRequest;

    beforeEach(() => {
      lastRequest = null;
      server.removeAllListeners("request");
      server.on("request", (req, res) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          lastRequest = { method: req.method, url: req.url, body };
          res.writeHead(mockStatusCode, { "Content-Type": "application/json" });
          res.end(typeof mockResponse === "string" ? mockResponse : JSON.stringify(mockResponse));
        });
      });
    });

    it("asks the key service for the named key and returns its 32 bytes", async () => {
      mockResponse = { key: KEY };

      const key = await generateKey("some/key/id", "secp256k1", socketPath);

      expect(Buffer.from(key).toString("hex")).to.equal(KEY);
      expect(key).to.be.instanceOf(Uint8Array);
      expect(lastRequest.method).to.equal("POST");
      expect(lastRequest.url).to.equal("/rofl/v1/keys/generate");
      expect(JSON.parse(lastRequest.body)).to.deep.equal({
        key_id: "some/key/id",
        kind: "secp256k1",
      });
    });

    it("accepts a key written with 0x or in upper case", async () => {
      mockResponse = { key: `0x${KEY.toUpperCase()}` };

      const key = await generateKey("id", "secp256k1", socketPath);

      expect(Buffer.from(key).toString("hex")).to.equal(KEY);
    });

    it("refuses an answer that is not a 32-byte key, without repeating it", async () => {
      for (const answer of [{ key: "not-a-key-but-a-secret" }, { key: KEY.slice(2) }, {}, "junk"]) {
        mockResponse = answer;
        let failure;
        try {
          await generateKey("id", "secp256k1", socketPath);
        } catch (error) {
          failure = error;
        }
        expect(failure, JSON.stringify(answer)).to.be.an("Error");
        expect(failure.message).to.include("not a 32-byte key");
        expect(failure.message).to.not.include("secret");
        expect(failure.message).to.not.include(KEY.slice(2));
      }
    });

    it("reports a refusal by its status and length only", async () => {
      mockStatusCode = 400;
      mockResponse = { error: "not initialized, with detail that must not be printed" };

      let failure;
      try {
        await generateKey("id", "secp256k1", socketPath);
      } catch (error) {
        failure = error;
      }

      expect(failure.message).to.match(/^The ROFL key service answered 400 \(\d+ bytes\)$/);
      expect(failure.status).to.equal(400);
      expect(failure.message).to.not.include("detail");
    });

    it("fails when the socket is not there", async () => {
      let failure;
      try {
        await generateKey("id", "secp256k1", "/invalid/socket/path");
      } catch (error) {
        failure = error;
      }

      expect(failure.message).to.include("ENOENT");
    });

    it("prints nothing", async () => {
      mockResponse = { key: KEY };
      const spy = sinon.spy(console, "log");
      try {
        await generateKey("id", "secp256k1", socketPath);
        expect(spy.callCount).to.equal(0);
      } finally {
        spy.restore();
      }
    });
  });

  describe("getAppId", function () {
    it("reads the app id the machine runs under", async () => {
      server.removeAllListeners("request");
      let seen;
      server.on("request", (req, res) => {
        seen = { method: req.method, url: req.url };
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("rofl1qqn9xndja7e2pnxhttktmecvwzz0yqwxsquqyxdf\n");
      });

      const appId = await getAppId(socketPath);

      expect(appId).to.equal("rofl1qqn9xndja7e2pnxhttktmecvwzz0yqwxsquqyxdf");
      expect(seen).to.deep.equal({ method: "GET", url: "/rofl/v1/app/id" });
    });
  });

  it("no longer offers the old key fetch, which printed what it sent", () => {
    expect(roflUtility).to.not.have.property("fetchKey");
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
