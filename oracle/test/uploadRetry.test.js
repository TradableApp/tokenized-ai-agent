"use strict";

// The oracle's payload upload has to survive a transient storage-provider failure. On the
// 2026-11-09 Base Sepolia run day one Autonomys chunk upload answered 503 and the whole prompt
// was dropped as fatal: the SDK's error text is `Failed to upload file chunk: Service
// Unavailable`, which no string in the retryable-error classifier matched. These tests pin the
// retry helper that sits between the SDK and the event handler, and the TYPE it surfaces.

const { expect } = require("chai");
const sinon = require("sinon");

const { isRetryableError } = require("../src/errors");
const { isTransientUploadError, uploadWithRetry } = require("../src/storage/uploadRetry");

const sdk503 = () => new Error("Failed to upload file chunk: Service Unavailable");

describe("isTransientUploadError", () => {
  for (const message of [
    "Failed to upload file chunk: Service Unavailable",
    "Failed to upload file chunk: Bad Gateway",
    "Failed to upload file chunk: Gateway Timeout",
    "Failed to upload file chunk: Too Many Requests",
    "Failed to upload file chunk: Internal Server Error",
    "request failed with status 503",
    "fetch failed",
    "read ECONNRESET",
    "connect ETIMEDOUT 1.2.3.4:443",
  ]) {
    it(`treats "${message}" as transient`, () => {
      expect(isTransientUploadError(new Error(message))).to.equal(true);
    });
  }

  for (const message of [
    "Insufficient upload credits: 10 bytes needed, 0 remaining.",
    "Autonomys Auto Drive not initialized.",
    "Failed to upload file chunk: Unauthorized",
    "Failed to upload file chunk: Payload Too Large",
  ]) {
    it(`treats "${message}" as permanent`, () => {
      expect(isTransientUploadError(new Error(message))).to.equal(false);
    });
  }

  it("is false for a non-Error value", () => {
    expect(isTransientUploadError(undefined)).to.equal(false);
    expect(isTransientUploadError("Service Unavailable")).to.equal(false);
  });
});

describe("uploadWithRetry", () => {
  const noSleep = sinon.stub().resolves();

  it("returns the CID when the first attempt succeeds, without sleeping", async () => {
    const attempt = sinon.stub().resolves("bafy-cid");
    const cid = await uploadWithRetry(attempt, { sleep: noSleep });

    expect(cid).to.equal("bafy-cid");
    expect(attempt.callCount).to.equal(1);
    expect(noSleep.called).to.equal(false);
  });

  it("retries a transient failure and returns the CID of the attempt that succeeded", async () => {
    const attempt = sinon.stub();
    attempt.onFirstCall().rejects(sdk503());
    attempt.onSecondCall().resolves("bafy-cid");
    const sleep = sinon.stub().resolves();
    const onRetry = sinon.spy();

    const cid = await uploadWithRetry(attempt, { sleep, onRetry });

    expect(cid).to.equal("bafy-cid");
    expect(attempt.callCount).to.equal(2);
    expect(sleep.callCount).to.equal(1);
    // The second argument is the 1-based number of the attempt about to run: 2 after the first failure.
    sinon.assert.calledOnceWithMatch(onRetry, sinon.match.instanceOf(Error), 2);
  });

  it("backs off exponentially with jitter between attempts", async () => {
    const attempt = sinon.stub().rejects(sdk503());
    const sleep = sinon.stub().resolves();
    const random = () => 0; // no jitter: the pure base delays

    await uploadWithRetry(attempt, { attempts: 4, sleep, random }).catch(() => {});

    expect(sleep.getCalls().map((c) => c.args[0])).to.deep.equal([1_000, 2_000, 4_000]);
  });

  it("surfaces a RetryableError (cause attached) once every attempt has failed transiently", async () => {
    const attempt = sinon.stub().rejects(sdk503());

    let caught;
    try {
      await uploadWithRetry(attempt, { attempts: 3, sleep: noSleep });
    } catch (error) {
      caught = error;
    }

    expect(attempt.callCount).to.equal(3);
    expect(isRetryableError(caught), "the handler must branch on TYPE").to.equal(true);
    expect(caught.message).to.include("3 attempts");
    expect(caught.message).to.include("Service Unavailable");
    expect(caught.cause).to.be.instanceOf(Error);
  });

  it("does not retry a permanent failure and rethrows it unchanged", async () => {
    const permanent = new Error("Insufficient upload credits: 10 bytes needed, 0 remaining.");
    const attempt = sinon.stub().rejects(permanent);
    const sleep = sinon.stub().resolves();

    let caught;
    try {
      await uploadWithRetry(attempt, { sleep });
    } catch (error) {
      caught = error;
    }

    expect(caught).to.equal(permanent);
    expect(isRetryableError(caught)).to.equal(false);
    expect(attempt.callCount).to.equal(1);
    expect(sleep.called).to.equal(false);
  });
});
