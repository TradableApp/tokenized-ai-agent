const chai = require("chai");
const sinon = require("sinon");
const { expect } = chai;
const fs = require("fs");
const http = require("http");
const path = require("path");
const { fetchKey, submitTx } = require("../src/roflUtility");

describe("RoflUtility", function () {
  let server;
  let socketPath;

  beforeEach((done) => {
    socketPath = "/tmp/appd_test_socket.sock";

    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }

    const serverHandler = (req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        let response = {};
        if (req.url === "/rofl/v1/keys/generate") {
          response = { key: "test_key" };
        } else if (req.url === "/rofl/v1/tx/sign-submit") {
          response = { txHash: "0x123" };
        } else {
          response = { error: "Not found" };
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response));
      });
    };

    server = http.createServer(serverHandler);
    server.listen(socketPath, done);
  });

  afterEach((done) => {
    server.close(() => {
      if (fs.existsSync(socketPath)) {
        fs.unlinkSync(socketPath);
      }
      done();
    });
  });

  it("fetchKey returns key successfully", async () => {
    const key = await fetchKey("test_id", socketPath);
    expect(key).to.equal("test_key");
  });

  it("submitTx returns txHash successfully", async () => {
    const tx = {
      gas: 1000000,
      to: "0x123",
      value: 0,
      data: "0x123",
    };
    const result = await submitTx(tx, socketPath);
    expect(result.txHash).to.equal("0x123");
  });

  it("fetchKey throws error if fetch fails", async () => {
    await expect(fetchKey("test_id", "/invalid/socket")).to.be.rejected;
  });

  it("submitTx throws error if fetch fails", async () => {
    const tx = {
      gas: 0,
      to: "0x123",
      value: 1000,
      data: "",
    };
    await expect(submitTx(tx, "/invalid/socket")).to.be.rejected;
  });
});
