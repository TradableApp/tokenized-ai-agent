"use strict";

const chai = require("chai");
const sinon = require("sinon");

const { expect } = chai;
const { collectCids, backfillCid } = require("../scripts/mirror-backfill");

// One-off / resumable backfill of payload CIDs that pre-date the write-through mirror. The
// subgraph is the index of every CID the dApp will ever ask for; Auto Drive is the source of
// bytes AND of the original file name (part of the CID, needed by the dApp to verify it).

const BUCKET = "tradable-app-garrick-senseai-payloads";
const CID_A = "bafkr6iaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CID_B = "bafkr6ibbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CID_C = "bafkr6icccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const CID_D = "bafkr6idddddddddddddddddddddddddddddddddddddddddddddddddddddd";

describe("mirror backfill (scripts/mirror-backfill.js)", () => {
  afterEach(() => sinon.restore());

  describe("collectCids", () => {
    it("gathers every payload CID a conversation page points at, deduplicated, in first-seen order", () => {
      const page = [
        {
          conversationCID: CID_A,
          conversationMetadataCID: CID_B,
          messages: [
            { messageCID: CID_C, searchDelta: { searchDeltaCID: CID_D } },
            { messageCID: CID_C, searchDelta: null },
          ],
        },
        { conversationCID: CID_A, conversationMetadataCID: "", messages: [] },
      ];

      expect(collectCids(page)).to.deep.equal([CID_A, CID_B, CID_C, CID_D]);
    });

    it("ignores legacy Arweave ids and mock CIDs — only Auto Drive CIDs can be mirrored", () => {
      const page = [
        {
          conversationCID: "mock_0123456789abcdef0123",
          conversationMetadataCID: "aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789_-abcde",
          messages: [{ messageCID: CID_A, searchDelta: null }],
        },
      ];

      expect(collectCids(page)).to.deep.equal([CID_A]);
    });
  });

  describe("backfillCid", () => {
    function depsWith(overrides = {}) {
      return {
        bucket: BUCKET,
        env: { PAYLOAD_MIRROR_BUCKET: BUCKET, PAYLOAD_MIRROR_SA_KEY: "{}" },
        headImpl: sinon.stub().resolves({ status: 404 }),
        lookupName: sinon.stub().resolves("file-1700000000000.json"),
        download: sinon.stub().resolves(Buffer.from("iv.ciphertext")),
        mirror: sinon.stub().resolves({ status: "created" }),
        dryRun: false,
        ...overrides,
      };
    }

    it("skips a CID the bucket already serves, without touching Auto Drive", async () => {
      const deps = depsWith({ headImpl: sinon.stub().resolves({ status: 200 }) });

      const result = await backfillCid(CID_A, deps);

      expect(result.status).to.equal("present");
      expect(deps.headImpl.firstCall.args[0]).to.equal(`https://storage.googleapis.com/${BUCKET}/${CID_A}`);
      expect(deps.headImpl.firstCall.args[1].method).to.equal("HEAD");
      expect(deps.download.called).to.equal(false);
      expect(deps.mirror.called).to.equal(false);
    });

    it("downloads the bytes, recovers the original file name and mirrors under the CID", async () => {
      const deps = depsWith();

      const result = await backfillCid(CID_A, deps);

      expect(result.status).to.equal("created");
      expect(deps.lookupName.calledOnceWith(CID_A)).to.equal(true);
      expect(deps.download.calledOnceWith(CID_A)).to.equal(true);
      const [cid, bytes, fileName, mirrorDeps] = deps.mirror.firstCall.args;
      expect(cid).to.equal(CID_A);
      expect(bytes.toString()).to.equal("iv.ciphertext");
      expect(fileName).to.equal("file-1700000000000.json");
      expect(mirrorDeps.env.PAYLOAD_MIRROR_BUCKET).to.equal(BUCKET);
    });

    it("reports a missing CID as pending in dry-run mode without downloading or writing", async () => {
      const deps = depsWith({ dryRun: true });

      const result = await backfillCid(CID_A, deps);

      expect(result.status).to.equal("pending");
      expect(deps.download.called).to.equal(false);
      expect(deps.mirror.called).to.equal(false);
    });

    it("refuses to mirror a payload whose Auto Drive name cannot be recovered", async () => {
      // Without the original name the dApp cannot recompute the CID, so an unnamed object would
      // fail verification on every read — worse than no object, because it costs a round trip.
      const deps = depsWith({ lookupName: sinon.stub().resolves(null) });

      const result = await backfillCid(CID_A, deps);

      expect(result.status).to.equal("failed");
      expect(result.reason).to.match(/name/i);
      expect(deps.mirror.called).to.equal(false);
    });

    it("never throws — a download failure becomes a failed result so the run continues", async () => {
      const deps = depsWith({ download: sinon.stub().rejects(new Error("gateway 503")) });

      const result = await backfillCid(CID_A, deps);

      expect(result.status).to.equal("failed");
      expect(result.reason).to.contain("gateway 503");
    });
  });
});
