"use strict";

// The Autonomys storage wrapper is where the SDK's raw errors become the oracle's typed ones.
// 2026-11-09 Base Sepolia run day: one chunk upload answered `Service Unavailable`, the wrapper
// rethrew the SDK error untouched, and handleAndRecord dropped the prompt as fatal. The wrapper
// must retry a transient failure itself and, if it still fails, surface a RetryableError so the
// event lands in the retry queue instead.

const { expect } = require("chai");
const sinon = require("sinon");
const proxyquire = require("proxyquire").noCallThru();

const { isRetryableError } = require("../src/errors");

const SDK_503 = "Failed to upload file chunk: Service Unavailable";

describe("autonomys.uploadData — transient failures", () => {
  let autonomys;
  let uploadFile;
  let sendAlert;
  let originalFetch;
  let originalKey;

  beforeEach(async () => {
    uploadFile = sinon.stub();
    sendAlert = sinon.stub().resolves();
    autonomys = proxyquire("../src/storage/autonomys", {
      "@autonomys/auto-drive": { createAutoDriveApi: () => ({ uploadFile }) },
      "@autonomys/auto-utils": { NetworkId: { MAINNET: "mainnet", TAURUS: "taurus" } },
      "../alerting": { sendAlert },
    });
    originalKey = process.env.AUTONOMYS_API_KEY;
    process.env.AUTONOMYS_API_KEY = "test-key";
    // The credit check reads the account over plain fetch; give it plenty of credit.
    originalFetch = global.fetch;
    global.fetch = sinon.stub().resolves({
      ok: true,
      status: 200,
      json: async () => ({ pendingUploadCredits: 10 ** 12, pendingDownloadCredits: 10 ** 12 }),
    });
    await autonomys.initializeAutoDrive();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) {
      delete process.env.AUTONOMYS_API_KEY;
    } else {
      process.env.AUTONOMYS_API_KEY = originalKey;
    }
    sinon.restore();
  });

  const noSleep = { sleep: async () => {} };

  it("retries the SDK's 503 and returns the CID of the second attempt, with no upload alert", async () => {
    uploadFile.onFirstCall().rejects(new Error(SDK_503));
    uploadFile.onSecondCall().resolves("bafy-second");

    const cid = await autonomys.uploadData(Buffer.from("{}"), [], noSleep);

    expect(cid).to.equal("bafy-second");
    expect(uploadFile.callCount).to.equal(2);
    const uploadAlerts = sendAlert.getCalls().filter((c) => /upload/i.test(c.args[0]));
    expect(uploadAlerts, "a recovered retry must not page").to.have.lengthOf(0);
  });

  it("surfaces a RetryableError once every attempt fails transiently, alerting once below CRITICAL", async () => {
    uploadFile.rejects(new Error(SDK_503));

    let caught;
    try {
      await autonomys.uploadData(Buffer.from("{}"), [], noSleep);
    } catch (error) {
      caught = error;
    }

    expect(isRetryableError(caught), "handleAndRecord must be able to queue this").to.equal(true);
    expect(caught.message).to.include("Service Unavailable");
    const uploadAlerts = sendAlert.getCalls().filter((c) => /upload/i.test(c.args[0]));
    expect(uploadAlerts).to.have.lengthOf(1);
    expect(uploadAlerts[0].args[0]).to.not.match(/^CRITICAL/);
  });

  it("treats a transient failure of the credit check as retryable too — RetryableError, no CRITICAL", async () => {
    // The credit check is a separate fetch to the Auto Drive account API, outside the upload
    // retry loop. A 503 there is the same outage; it must leave with the same type and severity.
    global.fetch = sinon.stub().resolves({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      json: async () => ({}),
    });

    let caught;
    try {
      await autonomys.uploadData(Buffer.from("{}"), [], noSleep);
    } catch (error) {
      caught = error;
    }

    expect(isRetryableError(caught)).to.equal(true);
    expect(uploadFile.called, "no upload is attempted without a credit check").to.equal(false);
    const critical = sendAlert.getCalls().filter((c) => /^CRITICAL/.test(c.args[0]));
    expect(critical, "a transient credit-check failure must not page as CRITICAL").to.have.lengthOf(
      0,
    );
  });

  it("throws a permanent failure unchanged after one attempt and alerts CRITICAL", async () => {
    const permanent = new Error("Failed to upload file chunk: Unauthorized");
    uploadFile.rejects(permanent);

    let caught;
    try {
      await autonomys.uploadData(Buffer.from("{}"), [], noSleep);
    } catch (error) {
      caught = error;
    }

    expect(caught).to.equal(permanent);
    expect(isRetryableError(caught)).to.equal(false);
    expect(uploadFile.callCount).to.equal(1);
    sinon.assert.calledOnceWithMatch(sendAlert, "CRITICAL: Autonomys Upload Failed");
  });
});
