"use strict";

const chai = require("chai");
const sinon = require("sinon");
const proxyquire = require("proxyquire").noCallThru();

const { expect } = chai;

// Write-through mirror of every Autonomys payload CID to the per-network GCS bucket.
//
// The mirror is a CACHE: Autonomys stays the permanence layer and the on-chain CID stays the
// root of trust (the dApp verifies mirror bytes against it). What these tests pin down is the
// posture, not the transport: the mirror never fails or delays a prompt, is a no-op when the
// bucket is unset, treats "already there" as success, retries transient failures with bounded
// backoff, gives up on permanent ones immediately, and alerts ONCE per process — not per CID.

const BUCKET = "tradable-app-garrick-senseai-payloads";
const CID = "bafkr6igmnn3rw3aziii6weewtsm2jtmeom3d6kjbj3nni6guajdugr6d2q";
const FILE_NAME = "file-1700000000000.json";
const DATA = Buffer.from("iv.ciphertext");

function load(env = {}) {
  const previous = { ...process.env };
  delete process.env.PAYLOAD_MIRROR_BUCKET;
  delete process.env.PAYLOAD_MIRROR_SA_KEY;
  Object.assign(process.env, env);
  const mirror = proxyquire("../src/storage/mirror", {
    "../alerting": { sendAlert: sinon.stub().resolves() },
  });
  process.env = previous;

  return mirror;
}

function depsWith(overrides = {}) {
  return {
    env: {
      PAYLOAD_MIRROR_BUCKET: BUCKET,
      PAYLOAD_MIRROR_SA_KEY: '{"client_email":"x","private_key":"y"}',
    },
    getToken: sinon.stub().resolves("tok-123"),
    sleep: sinon.stub().resolves(),
    random: () => 0,
    alert: sinon.stub().resolves(),
    ...overrides,
  };
}

const response = (status, body = "") => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => body,
});

describe("payload mirror (storage/mirror.js)", function () {
  afterEach(() => sinon.restore());

  describe("isEnabled", () => {
    it("is off when PAYLOAD_MIRROR_BUCKET is unset or blank", () => {
      const mirror = load();

      expect(mirror.isEnabled({})).to.equal(false);
      expect(mirror.isEnabled({ PAYLOAD_MIRROR_BUCKET: "   " })).to.equal(false);
    });

    it("is on when a bucket is configured", () => {
      const mirror = load();

      expect(mirror.isEnabled({ PAYLOAD_MIRROR_BUCKET: BUCKET })).to.equal(true);
    });
  });

  describe("backoffDelayMs", () => {
    it("doubles per attempt from 1 s, caps at 60 s, and adds up to 25% jitter", () => {
      const mirror = load();

      expect(mirror.backoffDelayMs(0, () => 0)).to.equal(1000);
      expect(mirror.backoffDelayMs(1, () => 0)).to.equal(2000);
      expect(mirror.backoffDelayMs(2, () => 1)).to.equal(5000);
      expect(mirror.backoffDelayMs(10, () => 0)).to.equal(60000);
      expect(mirror.backoffDelayMs(10, () => 1)).to.equal(75000);
    });
  });

  describe("buildMultipartBody", () => {
    it("carries the object name, content type, immutable cache control, the Auto Drive file name and the bytes", () => {
      const mirror = load();

      const { body, contentType } = mirror.buildMultipartBody(CID, DATA, FILE_NAME, "sep");
      const text = body.toString("utf8");

      expect(contentType).to.equal("multipart/related; boundary=sep");
      expect(text).to.contain('"name":"' + CID + '"');
      expect(text).to.contain('"contentType":"text/plain"');
      expect(text).to.contain('"cacheControl":"public, max-age=31536000, immutable"');
      expect(text).to.contain('"metadata":{"name":"' + FILE_NAME + '"}');
      expect(text).to.contain("iv.ciphertext");
      expect(text.trim().endsWith("--sep--")).to.equal(true);
    });
  });

  describe("mirrorPayload", () => {
    it("skips without touching the network when the bucket is unset", async () => {
      const mirror = load();
      const fetchImpl = sinon.stub();

      const result = await mirror.mirrorPayload(
        CID,
        DATA,
        FILE_NAME,
        depsWith({ env: {}, fetchImpl }),
      );

      expect(result.status).to.equal("skipped");
      expect(fetchImpl.called).to.equal(false);
      expect(mirror.snapshot()).to.deep.equal({ mirrored: 0, failed: 0, skipped: 1 });
    });

    it("uploads once to the bucket with the CID as the object name and ifGenerationMatch=0", async () => {
      const mirror = load();
      const fetchImpl = sinon.stub().resolves(response(200, "{}"));
      const deps = depsWith({ fetchImpl });

      const result = await mirror.mirrorPayload(CID, DATA, FILE_NAME, deps);

      expect(result.status).to.equal("created");
      expect(fetchImpl.calledOnce).to.equal(true);
      const [url, init] = fetchImpl.firstCall.args;
      expect(url).to.equal(
        `https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o?uploadType=multipart&name=${CID}&ifGenerationMatch=0`,
      );
      expect(init.method).to.equal("POST");
      expect(init.headers.Authorization).to.equal("Bearer tok-123");
      expect(init.headers["Content-Type"]).to.match(/^multipart\/related; boundary=/);
      expect(mirror.snapshot()).to.deep.equal({ mirrored: 1, failed: 0, skipped: 0 });
    });

    it("treats 412 (object already exists) as success and does not retry", async () => {
      const mirror = load();
      const fetchImpl = sinon.stub().resolves(response(412, "precondition"));
      const deps = depsWith({ fetchImpl });

      const result = await mirror.mirrorPayload(CID, DATA, FILE_NAME, deps);

      expect(result.status).to.equal("exists");
      expect(fetchImpl.calledOnce).to.equal(true);
      expect(deps.sleep.called).to.equal(false);
      expect(mirror.snapshot().mirrored).to.equal(1);
    });

    it("retries a transient failure with backoff and succeeds", async () => {
      const mirror = load();
      const fetchImpl = sinon.stub();
      fetchImpl.onFirstCall().resolves(response(503, "unavailable"));
      fetchImpl.onSecondCall().rejects(new Error("socket hang up"));
      fetchImpl.onThirdCall().resolves(response(200, "{}"));
      const deps = depsWith({ fetchImpl });

      const result = await mirror.mirrorPayload(CID, DATA, FILE_NAME, deps);

      expect(result.status).to.equal("created");
      expect(fetchImpl.callCount).to.equal(3);
      expect(deps.sleep.callCount).to.equal(2);
      expect(deps.sleep.firstCall.args[0]).to.equal(1000);
      expect(deps.sleep.secondCall.args[0]).to.equal(2000);
      expect(deps.alert.called).to.equal(false);
    });

    it("gives up after five attempts, counts the failure and alerts once per process", async () => {
      const mirror = load();
      const fetchImpl = sinon.stub().resolves(response(500, "boom"));
      const deps = depsWith({ fetchImpl });

      const first = await mirror.mirrorPayload(CID, DATA, FILE_NAME, deps);
      const second = await mirror.mirrorPayload(CID + "2", DATA, FILE_NAME, deps);

      expect(first.status).to.equal("failed");
      expect(second.status).to.equal("failed");
      expect(fetchImpl.callCount).to.equal(10);
      expect(deps.alert.calledOnce).to.equal(true);
      expect(deps.alert.firstCall.args[0]).to.contain("Payload mirror");
      expect(mirror.snapshot()).to.deep.equal({ mirrored: 0, failed: 2, skipped: 0 });
    });

    it("does not retry a permanent rejection such as 403", async () => {
      const mirror = load();
      const fetchImpl = sinon.stub().resolves(response(403, "forbidden"));
      const deps = depsWith({ fetchImpl });

      const result = await mirror.mirrorPayload(CID, DATA, FILE_NAME, deps);

      expect(result.status).to.equal("failed");
      expect(fetchImpl.calledOnce).to.equal(true);
      expect(deps.sleep.called).to.equal(false);
      expect(deps.alert.calledOnce).to.equal(true);
    });

    it("counts a failure, and alerts, when the service-account key is unusable", async () => {
      const mirror = load();
      const fetchImpl = sinon.stub();
      const deps = depsWith({ fetchImpl, getToken: sinon.stub().rejects(new Error("bad key")) });

      const result = await mirror.mirrorPayload(CID, DATA, FILE_NAME, deps);

      expect(result.status).to.equal("failed");
      expect(fetchImpl.called).to.equal(false);
      expect(deps.alert.calledOnce).to.equal(true);
    });
  });

  describe("mirrorInBackground", () => {
    it("never rejects, even when the mirror throws synchronously", async () => {
      const mirror = load();
      const deps = depsWith({
        fetchImpl: () => {
          throw new Error("sync explosion");
        },
      });

      const outcome = await mirror.mirrorInBackground(CID, DATA, FILE_NAME, deps);

      expect(outcome.status).to.equal("failed");
    });
  });

  describe("access token", () => {
    it("builds a JWT client from the service-account JSON with the read_write storage scope", async () => {
      const getAccessToken = sinon.stub().resolves({ token: "jwt-token" });
      const JWT = sinon.stub().returns({ getAccessToken });
      const mirror = proxyquire("../src/storage/mirror", {
        "google-auth-library": { JWT },
        "../alerting": { sendAlert: sinon.stub().resolves() },
      });
      const env = {
        PAYLOAD_MIRROR_BUCKET: BUCKET,
        PAYLOAD_MIRROR_SA_KEY: JSON.stringify({
          client_email: "w@p.iam",
          private_key: "-----KEY-----",
        }),
      };

      const token = await mirror.getAccessToken(env);

      expect(token).to.equal("jwt-token");
      expect(JWT.calledOnce).to.equal(true);
      expect(JWT.firstCall.args[0]).to.deep.include({
        email: "w@p.iam",
        key: "-----KEY-----",
        scopes: ["https://www.googleapis.com/auth/devstorage.read_write"],
      });
    });
  });
});
