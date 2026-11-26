"use strict";

// A conversation's key file is found in the account's own Auto Drive files by its exact name.
// The SDK's "my files" search (`searchByNameOrCIDInMyFiles`) matches on a name or CID but does
// not promise an exact match, so a result is taken only when its name is the one asked for.

const { expect } = require("chai");
const sinon = require("sinon");
const proxyquire = require("proxyquire").noCallThru();

const KEY_LOOKUP_TAGS = [
  { name: "Content-Type", value: "application/rofl-key" },
  { name: "SenseAI-Key-For-Conversation", value: "8453-7" },
];

describe("autonomys.queryTransactionByTags — key files", () => {
  let autonomys;
  let search;
  let originalFetch;
  let originalKey;

  beforeEach(async () => {
    search = sinon.stub().resolves([]);
    autonomys = proxyquire("../src/storage/autonomys", {
      "@autonomys/auto-drive": {
        createAutoDriveApi: () => ({ searchByNameOrCIDInMyFiles: search }),
      },
      "@autonomys/auto-utils": { NetworkId: { MAINNET: "mainnet", TAURUS: "taurus" } },
      "../alerting": { sendAlert: sinon.stub().resolves() },
    });
    originalKey = process.env.AUTONOMYS_API_KEY;
    process.env.AUTONOMYS_API_KEY = "test-key";
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

  it("searches the account's files for the key file's own name", async () => {
    await autonomys.queryTransactionByTags(KEY_LOOKUP_TAGS);

    expect(search.calledOnceWith("rofl-key-8453-7.txt")).to.equal(true);
  });

  it("returns the file whose name is exactly the key file's, not the first result", async () => {
    search.resolves([
      { name: "rofl-key-8453-70.txt", headCid: "cid-of-70" },
      { name: "rofl-key-8453-7.txt", headCid: "cid-of-7" },
    ]);

    expect(await autonomys.queryTransactionByTags(KEY_LOOKUP_TAGS)).to.equal("cid-of-7");
  });

  it("finds nothing when no result has exactly that name", async () => {
    search.resolves([
      { name: "rofl-key-8453-70.txt", headCid: "cid-of-70" },
      { name: "8453-7", headCid: "cid-named-like-the-tag" },
      { headCid: "cid-with-no-name" },
    ]);

    expect(await autonomys.queryTransactionByTags(KEY_LOOKUP_TAGS)).to.equal(null);
  });

  it("matches a File-Name tag exactly too", async () => {
    search.resolves([
      { name: "a.json.bak", headCid: "cid-of-backup" },
      { name: "a.json", headCid: "cid-of-a" },
    ]);

    const cid = await autonomys.queryTransactionByTags([{ name: "File-Name", value: "a.json" }]);

    expect(search.calledOnceWith("a.json")).to.equal(true);
    expect(cid).to.equal("cid-of-a");
  });
});
