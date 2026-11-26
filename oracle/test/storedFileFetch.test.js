"use strict";

// A stored file is fetched by a content id the user chose, so the oracle must stay healthy
// whatever that id points at: every fetch has a byte limit enforced while the body arrives and a
// total time limit, and both end the request (the socket is closed, not left draining).
//
// Served from a local HTTP server on 127.0.0.1 through the real `fetch`; the provider's host name
// is rewritten to it. No other network.

const http = require("node:http");
const { expect } = require("chai");
const sinon = require("sinon");
const proxyquire = require("proxyquire").noCallThru();

const { isBadInputError, isRetryableError } = require("../src/errors");

const MIB = 1024 * 1024;
const CHUNK = 16 * 1024;
// Far past any limit under test, and finite so a fetch that does not stop still ends.
const ENDLESS = 12 * MIB;
// Bytes the client may hold past its limit: one read can bring up to a socket's worth.
const READ_SLACK = 256 * 1024;

const AUTONOMYS_ID = `bafkr6i${"a".repeat(52)}`;
const ARWEAVE_ID = "A".repeat(43);

/**
 * A local server whose every response is written by `respond(req, res, record)`. `record` counts
 * the bytes the server wrote and resolves `closed` when the client's connection ends.
 */
function startServer(respond) {
  const records = [];
  const server = http.createServer((req, res) => {
    let markClosed;
    const record = {
      path: req.url,
      written: 0,
      closed: new Promise((resolve) => {
        markClosed = resolve;
      }),
      isClosed: false,
    };
    res.on("close", () => {
      record.isClosed = true;
      markClosed();
    });
    records.push(record);
    respond(req, res, record);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        records,
        stop: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

/** Writes `total` bytes in 16 KiB chunks, honouring drain, and stops when the client goes. */
function streamBytes(res, record, total, { headers = {} } = {}) {
  res.writeHead(200, { "Content-Type": "text/plain", ...headers });
  const chunk = Buffer.alloc(CHUNK, 0x41);
  const pump = () => {
    while (!record.isClosed && record.written < total) {
      const size = Math.min(CHUNK, total - record.written);
      record.written += size;
      if (!res.write(size === CHUNK ? chunk : chunk.subarray(0, size))) {
        res.once("drain", pump);
        return;
      }
    }
    if (!record.isClosed) res.end();
  };
  pump();
}

/** One byte every `everyMs`, for ever. */
function dripBytes(res, record, everyMs) {
  res.writeHead(200, { "Content-Type": "text/plain" });
  const timer = setInterval(() => {
    if (record.isClosed) {
      clearInterval(timer);
      return;
    }
    record.written += 1;
    res.write("A");
  }, everyMs);
  res.on("close", () => clearInterval(timer));
}

/** Resolves true once the server saw the connection close, false after `ms`. */
function closedWithin(record, ms = 2000) {
  return Promise.race([
    record.closed.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
}

async function rejectionOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the fetch to be refused, and it resolved");
}

const realFetch = globalThis.fetch;

/** The providers, with their host names pointed at the local server. */
function loadProviders(base) {
  const sendAlert = sinon.stub().resolves();
  sinon.stub(globalThis, "fetch").callsFake((url, init) => {
    const text = String(url);
    if (text.endsWith("/accounts/@me")) {
      return Promise.resolve(
        new Response(JSON.stringify({ pendingUploadCredits: 1e12, pendingDownloadCredits: 1e12 })),
      );
    }
    return realFetch(text.replace(/^https:\/\/[^/]+/, base), init);
  });

  const arweave = proxyquire("../src/storage/arweave", {
    "../alerting": { sendAlert },
  });
  // The Auto Drive client, as the SDK builds it: its download request is a plain `fetch` of the
  // download service with the request options passed through, and `downloadFile` streams that
  // response's body.
  const autoDriveApi = {
    sendDownloadRequest: (path, request = {}) =>
      globalThis.fetch(`https://public.auto-drive.autonomys.xyz/api${path}`, request),
    downloadFile: async (cid) => {
      const response = await globalThis.fetch(
        `https://public.auto-drive.autonomys.xyz/api/downloads/${cid}?ignoreEncoding=true`,
      );
      return response.body;
    },
  };
  const autonomys = proxyquire("../src/storage/autonomys", {
    "@autonomys/auto-drive": { createAutoDriveApi: () => autoDriveApi },
    "@autonomys/auto-utils": { NetworkId: { MAINNET: "mainnet", TAURUS: "taurus" } },
    "../alerting": { sendAlert },
  });
  return { arweave, autonomys, sendAlert };
}

describe("stored file fetches are bounded", function () {
  this.timeout(10000);

  let server;
  let providers;
  let originalKey;

  async function serve(respond) {
    server = await startServer(respond);
    providers = loadProviders(server.base);
    await providers.autonomys.initializeAutoDrive();
    return server;
  }

  beforeEach(() => {
    originalKey = process.env.AUTONOMYS_API_KEY;
    process.env.AUTONOMYS_API_KEY = "test-key";
  });

  afterEach(async () => {
    sinon.restore();
    if (server) await server.stop();
    server = null;
    if (originalKey === undefined) delete process.env.AUTONOMYS_API_KEY;
    else process.env.AUTONOMYS_API_KEY = originalKey;
  });

  const cases = [
    { name: "Irys gateway (arweave.fetchData)", provider: "arweave", cid: ARWEAVE_ID },
    { name: "Auto Drive (autonomys.fetchData)", provider: "autonomys", cid: AUTONOMYS_ID },
  ];

  for (const { name, provider, cid } of cases) {
    describe(name, () => {
      it("returns a body within the limit unchanged", async () => {
        const body = "iv.ciphertext-within-the-limit";
        await serve((_req, res) => res.end(body));

        const data = await providers[provider].fetchData(cid, { maxBytes: MIB });

        expect(data).to.equal(body);
      });

      it("stops reading an endless body at the limit, refuses it as bad input and closes the socket", async () => {
        const served = await serve((_req, res, record) => streamBytes(res, record, ENDLESS));

        const error = await rejectionOf(providers[provider].fetchData(cid, { maxBytes: MIB }));

        expect(error.name).to.equal("StoredFileTooLargeError");
        expect(isBadInputError(error)).to.equal(true);
        expect(isRetryableError(error)).to.equal(false);
        expect(error.limitBytes).to.equal(MIB);
        expect(error.bytesRead)
          .to.be.above(MIB)
          .and.at.most(MIB + READ_SLACK);
        const [record] = served.records.filter((r) => r.path.includes(cid));
        expect(await closedWithin(record)).to.equal(true);
        expect(record.written).to.be.below(8 * MIB);
      });

      it("refuses a declared length over the limit before reading the body", async () => {
        const served = await serve((_req, res, record) =>
          streamBytes(res, record, 4 * MIB, { headers: { "Content-Length": String(4 * MIB) } }),
        );

        const error = await rejectionOf(providers[provider].fetchData(cid, { maxBytes: MIB }));

        expect(error.name).to.equal("StoredFileTooLargeError");
        expect(error.bytesRead).to.equal(0);
        const [record] = served.records.filter((r) => r.path.includes(cid));
        expect(await closedWithin(record)).to.equal(true);
      });

      it("ends a slow-drip body at the time limit as a retryable timeout and closes the socket", async () => {
        const served = await serve((_req, res, record) => dripBytes(res, record, 20));

        const started = Date.now();
        const error = await rejectionOf(
          providers[provider].fetchData(cid, { maxBytes: MIB, timeoutMs: 300 }),
        );

        expect(error.name).to.equal("StoredFileTimeoutError");
        expect(isRetryableError(error)).to.equal(true);
        expect(isBadInputError(error)).to.equal(false);
        expect(Date.now() - started).to.be.below(2000);
        const [record] = served.records.filter((r) => r.path.includes(cid));
        expect(await closedWithin(record)).to.equal(true);
      });

      it("applies a default byte limit when the caller names none", async () => {
        await serve((_req, res, record) => streamBytes(res, record, ENDLESS));

        const error = await rejectionOf(providers[provider].fetchData(cid));

        expect(error.name).to.equal("StoredFileTooLargeError");
        expect(error.bytesRead).to.be.below(ENDLESS);
      });

      it("does not alert for a body over the limit (the id's owner chose it)", async () => {
        await serve((_req, res, record) => streamBytes(res, record, 4 * MIB));

        await rejectionOf(providers[provider].fetchData(cid, { maxBytes: MIB }));

        expect(providers.sendAlert.called).to.equal(false);
      });
    });
  }

  it("does not trust a Content-Length that understates the body (stubbed response)", async () => {
    let pulled = 0;
    let cancelled = false;
    const endless = new ReadableStream({
      pull(controller) {
        if (pulled >= ENDLESS) {
          controller.close();
          return;
        }
        pulled += CHUNK;
        controller.enqueue(new Uint8Array(CHUNK));
      },
      cancel() {
        cancelled = true;
      },
    });
    const { arweave } = loadProviders("http://127.0.0.1:9");
    globalThis.fetch.callsFake(() =>
      Promise.resolve(new Response(endless, { headers: { "Content-Length": "16" } })),
    );

    const error = await rejectionOf(arweave.fetchData(ARWEAVE_ID, { maxBytes: MIB }));

    expect(error.name).to.equal("StoredFileTooLargeError");
    expect(error.bytesRead).to.be.at.most(MIB + CHUNK);
    expect(pulled).to.be.below(2 * MIB);
    expect(cancelled).to.equal(true);
  });

  it("takes a body of exactly the limit and refuses one byte more", async () => {
    const { arweave } = loadProviders("http://127.0.0.1:9");

    globalThis.fetch.callsFake(() => Promise.resolve(new Response(Buffer.alloc(MIB, 0x41))));
    expect(await arweave.fetchData(ARWEAVE_ID, { maxBytes: MIB })).to.have.lengthOf(MIB);

    globalThis.fetch.callsFake(() => Promise.resolve(new Response(Buffer.alloc(MIB + 1, 0x41))));
    const error = await rejectionOf(arweave.fetchData(ARWEAVE_ID, { maxBytes: MIB }));
    expect(error.name).to.equal("StoredFileTooLargeError");
  });

  it("never reads more than the default limit, whatever limit a caller asks for", async () => {
    const { MAX_STORED_FILE_BYTES } = require("../src/storage/storedFileFetch");
    const { arweave } = loadProviders("http://127.0.0.1:9");
    globalThis.fetch.callsFake(() =>
      Promise.resolve(new Response(Buffer.alloc(MAX_STORED_FILE_BYTES + 1, 0x41))),
    );

    const error = await rejectionOf(
      arweave.fetchData(ARWEAVE_ID, { maxBytes: 4 * MAX_STORED_FILE_BYTES }),
    );

    expect(error.name).to.equal("StoredFileTooLargeError");
    expect(error.limitBytes).to.equal(MAX_STORED_FILE_BYTES);
  });
});

describe("stored file fetch edge cases", function () {
  this.timeout(10000);
  const zlib = require("node:zlib");
  const {
    fetchStoredFile,
    MAX_STORED_FILE_BYTES,
    STORED_FILE_TIMEOUT_MS,
  } = require("../src/storage/storedFileFetch");
  let server;

  afterEach(async () => {
    if (server) await server.stop();
    server = null;
  });

  const refusal = (response) => new Error(`status ${response.status}`);

  it("counts a gzip body as it is decoded, and stops at the limit", async () => {
    const compressed = zlib.gzipSync(Buffer.alloc(ENDLESS, 0));
    server = await startServer((_req, res, record) => {
      res.writeHead(200, { "Content-Encoding": "gzip", "Content-Type": "text/plain" });
      record.written = compressed.length;
      res.end(compressed);
    });

    const error = await rejectionOf(
      fetchStoredFile((signal) => realFetch(`${server.base}/gz`, { signal }), {
        maxBytes: MIB,
        refusal,
      }),
    );

    expect(error.name).to.equal("StoredFileTooLargeError");
    expect(error.bytesRead)
      .to.be.above(MIB)
      .and.at.most(MIB + READ_SLACK);
    expect(compressed.length, "the wire carried far less than the limit").to.be.below(MIB);
  });

  it("refuses a response that is not ok with a plain error naming only its status, when no refusal is given", async () => {
    const response = new Response("the service's own words", {
      status: 503,
      statusText: "Service Unavailable from somewhere",
    });

    const error = await rejectionOf(fetchStoredFile(async () => response));

    expect(error).to.be.an.instanceof(Error);
    expect(error.name).to.equal("Error");
    expect(error.message).to.equal("Stored file fetch refused: status 503.");
  });

  it("refuses a key file one byte over its 4 KiB limit through a real fetch", async () => {
    server = await startServer((_req, res) => res.end(Buffer.alloc(4097, 0x30)));

    const error = await rejectionOf(
      fetchStoredFile((signal) => realFetch(`${server.base}/key`, { signal }), {
        maxBytes: 4096,
        refusal,
      }),
    );

    expect(error.name).to.equal("StoredFileTooLargeError");
    expect(error.limitBytes).to.equal(4096);
  });

  for (const bad of [NaN, "abc", null, Infinity, -Infinity, {}]) {
    it(`falls back to the default byte limit for a maxBytes of ${String(bad)}`, async () => {
      const body = Buffer.alloc(MAX_STORED_FILE_BYTES + 1, 0x41);

      const error = await rejectionOf(
        fetchStoredFile(async () => new Response(body), { maxBytes: bad, refusal }),
      );

      expect(error.name).to.equal("StoredFileTooLargeError");
      expect(error.limitBytes).to.equal(MAX_STORED_FILE_BYTES);
    });

    it(`falls back to the default time limit for a timeoutMs of ${String(bad)}`, async () => {
      // Answers after 50 ms unless the fetch is ended first, as a real fetch would be.
      const slow = (signal) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(new Response("late but fine")), 50);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("ended"));
          });
        });
      let timedOut = null;
      const body = await fetchStoredFile(slow, { timeoutMs: bad, refusal }).catch((error) => {
        timedOut = error;
      });

      expect(timedOut).to.equal(null);
      expect(body.toString()).to.equal("late but fine");
      expect(STORED_FILE_TIMEOUT_MS).to.be.above(50);
    });
  }
});

describe("the stored file limit", () => {
  const {
    LARGEST_WRITTEN_FILE_BYTES,
    MAX_STORED_FILE_BYTES,
    STORED_FILE_TIMEOUT_MS,
  } = require("../src/storage/storedFileFetch");
  const { LIMITS, sealedFrameChars } = require("../src/stream/streamContract");

  it("is above the largest file the oracle writes, with room, and not far above it", () => {
    // Reasoning (every attempt's steps at the frame limit), sources, a 1 MiB answer, the rest.
    const plaintext =
      LIMITS.maxAttempts * LIMITS.maxStepsPerAttempt * LIMITS.framePlaintextBytes +
      LIMITS.maxAttempts * LIMITS.framePlaintextBytes +
      MIB +
      1024;

    expect(LARGEST_WRITTEN_FILE_BYTES).to.equal(sealedFrameChars(plaintext));
    expect(MAX_STORED_FILE_BYTES).to.be.above(LARGEST_WRITTEN_FILE_BYTES * 1.1);
    expect(MAX_STORED_FILE_BYTES).to.be.below(LARGEST_WRITTEN_FILE_BYTES * 1.5);
  });

  it("gives the largest written file time to arrive at 2 Mbit/s", () => {
    const seconds = (LARGEST_WRITTEN_FILE_BYTES * 8) / 2e6;

    expect(STORED_FILE_TIMEOUT_MS).to.be.above(seconds * 1000);
  });
});
