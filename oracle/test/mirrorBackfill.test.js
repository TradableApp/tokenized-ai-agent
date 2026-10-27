"use strict";

const chai = require("chai");
const sinon = require("sinon");

const { expect } = chai;
const {
  collectCids,
  backfillCid,
  iterateCids,
  parseArgs,
  runBackfill,
  nameFromSearchResults,
} = require("../scripts/mirror-backfill");

// One-off / resumable backfill of payload CIDs that pre-date the write-through mirror. The
// subgraph is the index of every CID the dApp will ever ask for; Auto Drive is the source of
// bytes AND of the original file name (part of the CID, needed by the dApp to verify it).

const BUCKET = "tradable-app-garrick-senseai-payloads";
const CID_A = `bafkr6i${"a".repeat(52)}`;
const CID_B = `bafkr6i${"b".repeat(52)}`;
const CID_C = `bafkr6i${"c".repeat(52)}`;
const CID_D = `bafkr6i${"d".repeat(52)}`;

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

  describe("nameFromSearchResults", () => {
    it("returns the name of the result whose headCid is the CID", () => {
      const results = [
        { headCid: CID_B, name: "other.json" },
        { headCid: CID_A, name: "mine.json" },
      ];

      expect(nameFromSearchResults(CID_A, results)).to.equal("mine.json");
    });

    it("returns null — never a neighbour's name — when no result matches the CID", () => {
      // A wrong name would be mirrored as metadata, fail CID verification on every dApp read,
      // and cost a wasted round trip forever. No name means no object; the run reports it.
      expect(nameFromSearchResults(CID_A, [{ headCid: CID_B, name: "other.json" }])).to.equal(null);
      expect(nameFromSearchResults(CID_A, [])).to.equal(null);
      expect(nameFromSearchResults(CID_A, undefined)).to.equal(null);
      expect(nameFromSearchResults(CID_A, [{ headCid: CID_A }])).to.equal(null);
    });
  });

  describe("parseArgs", () => {
    it("defaults to a live run, 100-row pages and four parallel CIDs", () => {
      expect(parseArgs([])).to.deep.equal({ dryRun: false, pageSize: 100, concurrency: 4 });
    });

    it("reads --dry-run, --page-size and --concurrency", () => {
      expect(parseArgs(["--dry-run", "--page-size", "25", "--concurrency", "2"])).to.deep.equal({
        dryRun: true,
        pageSize: 25,
        concurrency: 2,
      });
    });

    it("rejects a non-positive or non-integer page size instead of silently paging nothing", () => {
      expect(() => parseArgs(["--page-size", "0"])).to.throw(/--page-size/);
      expect(() => parseArgs(["--concurrency", "two"])).to.throw(/--concurrency/);
    });
  });

  describe("iterateCids", () => {
    const SUBGRAPH = "https://api.studio.thegraph.com/query/x/senseai/v1";

    function graphResponse(conversations) {
      return { ok: true, status: 200, json: async () => ({ data: { conversations } }) };
    }

    it("pages by id cursor until an empty page, yielding each page's CIDs", async () => {
      const fetchStub = sinon.stub(globalThis, "fetch");
      fetchStub.onCall(0).resolves(
        graphResponse([
          { id: "0x1", conversationCID: CID_A, conversationMetadataCID: CID_B, messages: [] },
          { id: "0x2", conversationCID: CID_C, conversationMetadataCID: "", messages: [] },
        ]),
      );
      fetchStub
        .onCall(1)
        .resolves(
          graphResponse([
            { id: "0x3", conversationCID: CID_D, conversationMetadataCID: "", messages: [] },
          ]),
        );
      fetchStub.onCall(2).resolves(graphResponse([]));

      const pages = [];
      for await (const cids of iterateCids(SUBGRAPH, 2)) pages.push(cids);

      expect(pages).to.deep.equal([[CID_A, CID_B, CID_C], [CID_D]]);
      expect(fetchStub.callCount).to.equal(3);
      const secondVariables = JSON.parse(fetchStub.secondCall.args[1].body).variables;
      expect(secondVariables.lastId).to.equal("0x2");
      expect(secondVariables.first).to.equal(2);
    });

    it("surfaces a subgraph HTTP failure rather than treating it as the end of the data", async () => {
      sinon.stub(globalThis, "fetch").resolves({ ok: false, status: 502 });

      let error;
      try {
        for await (const _ of iterateCids(SUBGRAPH, 10)) void _;
      } catch (e) {
        error = e;
      }

      expect(error).to.be.an("error");
      expect(error.message).to.contain("502");
    });

    it("surfaces GraphQL-level errors", async () => {
      sinon.stub(globalThis, "fetch").resolves({
        ok: true,
        status: 200,
        json: async () => ({ errors: [{ message: "indexing_error" }] }),
      });

      let error;
      try {
        for await (const _ of iterateCids(SUBGRAPH, 10)) void _;
      } catch (e) {
        error = e;
      }

      expect(error.message).to.contain("indexing_error");
    });
  });

  describe("runBackfill", () => {
    it("tallies every outcome across pages and lists failures for the re-run", async () => {
      const page = (rows) => ({
        ok: true,
        status: 200,
        json: async () => ({ data: { conversations: rows } }),
      });
      const fetchStub = sinon.stub(globalThis, "fetch");
      fetchStub.onCall(0).resolves(
        page([
          { id: "0x1", conversationCID: CID_A, conversationMetadataCID: CID_B, messages: [] },
          { id: "0x2", conversationCID: CID_C, conversationMetadataCID: "", messages: [] },
        ]),
      );
      fetchStub.onCall(1).resolves(page([]));
      const headImpl = sinon.stub().resolves({ status: 404 });
      headImpl.withArgs(sinon.match(CID_A)).resolves({ status: 200 });
      const download = sinon.stub().resolves(Buffer.from("x"));
      download.withArgs(CID_C).rejects(new Error("gateway 503"));
      const logs = [];

      const result = await runBackfill({
        subgraphUrl: "https://subgraph.test/q",
        options: { dryRun: false, pageSize: 10, concurrency: 2 },
        deps: {
          bucket: BUCKET,
          env: {},
          headImpl,
          lookupName: sinon.stub().resolves("file-1.json"),
          download,
          mirror: sinon.stub().resolves({ status: "created" }),
          dryRun: false,
        },
        log: (line) => logs.push(line),
      });

      expect(result.scanned).to.equal(3);
      expect(result.tally).to.deep.equal({
        present: 1,
        pending: 0,
        created: 1,
        exists: 0,
        failed: 1,
      });
      expect(result.failures).to.deep.equal([`${CID_C}: gateway 503`]);
      expect(logs.some((l) => l.startsWith("created"))).to.equal(true);
      expect(logs.some((l) => l.includes(CID_A))).to.equal(false); // present CIDs stay quiet
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
      expect(deps.headImpl.firstCall.args[0]).to.equal(
        `https://storage.googleapis.com/${BUCKET}/${CID_A}`,
      );
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
