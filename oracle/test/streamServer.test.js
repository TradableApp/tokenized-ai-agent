const { expect } = require("chai");
const sinon = require("sinon");
const proxyquire = require("proxyquire");
const http = require("node:http");
const net = require("node:net");
const { EventEmitter } = require("node:events");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const {
  LIMITS,
  STREAM_HTTP,
  STREAM_REFUSALS,
  isSink,
  streamProof,
} = require("../src/stream/streamContract");
const {
  createStreamServer,
  startStreamFromEnv,
  httpLimitsFor,
  readerQueueCap,
} = require("../src/stream/streamServer");
const { readStreamConfig, SOCKET_BUDGET } = require("../src/stream/streamConfig");
const { BUFFER_LIMITS } = require("../src/stream/frameBuffer");

/**
 * The stream server, end to end: a real server on an ephemeral port, read with the real `fetch`
 * (for the event stream) and `node:http` (where a test needs a header fetch will not send, or a
 * raw request). Timings are real and kept short through the server's settings; each one asserted
 * is derived beside it.
 */

// The shared test vector's key (contract 1.9): made up, public, used for nothing else.
const KEY = Buffer.from("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "hex");
const OTHER_KEY = Buffer.alloc(32, 7);
const RUN_A = "0123456789abcdef";
const RUN_B = "fedcba9876543210";
const ALLOWED = "https://allowed.example";
const PROOF_HEADER = STREAM_HTTP.proofHeader;
const sealed = (n = 8) => `oKGio6Slpqeoqaqr.${"A".repeat(n)}`;

function testConfig(overrides = {}) {
  return {
    ...readStreamConfig({ NETWORK_NAME: "baseSepolia" }),
    allowedOrigins: [ALLOWED],
    ...overrides,
  };
}

async function startServer(configOverrides = {}, options = {}) {
  const server = createStreamServer({ config: testConfig(configOverrides), ...options });
  const { port } = await server.listen({ port: 0, host: "127.0.0.1" });
  return { server, base: `http://127.0.0.1:${port}`, port };
}

function openAnswer(server, id, run = RUN_A, key = KEY) {
  server.open(id, { run, replica: "deadbeef", expectedProof: streamProof(key, id) });
}

function sendFrames(server, id, run, fromSeq, count) {
  for (let seq = fromSeq; seq < fromSeq + count; seq += 1) {
    server.frame(id, { run, seq, ciphertext: sealed() });
  }
}

/** Parses an event stream into its events (comments and the retry line are kept apart). */
function parseSse(text) {
  const events = [];
  let pings = 0;
  let retry = null;
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    const event = {};
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) pings += 1;
      else if (line.startsWith("retry: ")) retry = Number(line.slice(7));
      else if (line.startsWith("id: ")) event.id = line.slice(4);
      else if (line.startsWith("event: ")) event.event = line.slice(7);
      else if (line.startsWith("data: ")) event.data = line.slice(6);
    }
    if (event.id) events.push(event);
  }
  return { events, pings, retry };
}

/**
 * Reads a streaming fetch response until `until(text)` is true, the response ends, or
 * `timeoutMs` passes; then cancels it. Returns the text and whether the server ended it.
 */
async function readUntil(res, { until = () => false, timeoutMs = 2000 } = {}) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let ended = false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const next = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), remaining)),
    ]);
    if (next.timedOut) break;
    if (next.done) {
      ended = true;
      break;
    }
    text += decoder.decode(next.value, { stream: true });
    if (until(text)) break;
  }
  if (!ended) await reader.cancel().catch(() => undefined);
  return { text, ended };
}

function streamFetch(base, id, { proof, lastEventId, mode, signal } = {}) {
  const headers = { Accept: "text/event-stream" };
  if (proof !== undefined) headers[PROOF_HEADER] = proof;
  if (lastEventId) headers[STREAM_HTTP.lastEventIdHeader] = lastEventId;
  const query = mode ? `?mode=${mode}` : "";
  return fetch(`${base}${STREAM_HTTP.streamPathPrefix}${id}${query}`, { headers, signal });
}

/** A plain request through node:http: any method, any header, an optional body. */
function rawRequest(port, { method = "GET", path, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("streamServer", function () {
  this.timeout(10000);
  let running = [];

  async function serve(configOverrides, options) {
    const started = await startServer(configOverrides, options);
    running.push(started.server);
    return started;
  }

  afterEach(async () => {
    await Promise.all(running.map((server) => server.shutdown()));
    running = [];
    sinon.restore();
  });

  it("is a sink: open, frame and close, none of which throws on nonsense", async () => {
    const { server } = await serve();
    expect(isSink(server)).to.equal(true);
    expect(() => server.open(undefined, undefined)).to.not.throw();
    expect(() => server.open("42", { run: "nope" })).to.not.throw();
    expect(() => server.frame("999", { run: RUN_A, seq: 0, ciphertext: sealed() })).to.not.throw();
    expect(() => server.frame(null, null)).to.not.throw();
    expect(() => server.close("999", {})).to.not.throw();
  });

  describe("a reader with the right proof", () => {
    it("gets every frame in order, live, with the event-stream headers, and the stream ends after done", async () => {
      const { server, base } = await serve();
      openAnswer(server, "42");
      sendFrames(server, "42", RUN_A, 0, 2);

      const res = await streamFetch(base, "42", { proof: streamProof(KEY, "42") });
      expect(res.status).to.equal(200);
      expect(res.headers.get("content-type")).to.equal("text/event-stream; charset=utf-8");
      expect(res.headers.get("cache-control")).to.equal("no-cache, no-transform");
      expect(res.headers.get("x-accel-buffering")).to.equal("no");
      expect(res.headers.get("content-encoding")).to.equal(null);

      const reading = readUntil(res, { timeoutMs: 3000 });
      // Sent while the reader is connected: they arrive on the open response.
      await sleep(50);
      sendFrames(server, "42", RUN_A, 2, 2);
      server.close("42", { run: RUN_A, outcome: "answered" });

      const { text, ended } = await reading;
      const { events, retry } = parseSse(text);
      expect(text.startsWith(`retry: ${STREAM_HTTP.sseRetryMs}\n\n`)).to.equal(true);
      expect(retry).to.equal(2000);
      expect(events.map((e) => e.id)).to.deep.equal([0, 1, 2, 3].map((s) => `${RUN_A}.${s}`));
      expect(events.every((e) => e.event === "frame" && e.data === sealed())).to.equal(true);
      expect(ended, "the server ends the response once the run is closed").to.equal(true);
    });

    it("gets only the rest after reconnecting mid-stream with Last-Event-ID", async () => {
      const { server, base } = await serve();
      openAnswer(server, "42");
      sendFrames(server, "42", RUN_A, 0, 4);
      server.close("42", { run: RUN_A, outcome: "answered" });

      const res = await streamFetch(base, "42", {
        proof: streamProof(KEY, "42"),
        lastEventId: `${RUN_A}.1`,
      });
      const { text, ended } = await readUntil(res);
      expect(parseSse(text).events.map((e) => e.id)).to.deep.equal([`${RUN_A}.2`, `${RUN_A}.3`]);
      expect(ended).to.equal(true);
    });

    it("gets the current run from seq 0 when Last-Event-ID names another run", async () => {
      const { server, base } = await serve();
      openAnswer(server, "42", RUN_B);
      sendFrames(server, "42", RUN_B, 0, 2);
      server.close("42", { run: RUN_B, outcome: "answered" });

      const res = await streamFetch(base, "42", {
        proof: streamProof(KEY, "42"),
        lastEventId: `${RUN_A}.7`,
      });
      const { text } = await readUntil(res);
      expect(parseSse(text).events.map((e) => e.id)).to.deep.equal([`${RUN_B}.0`, `${RUN_B}.1`]);
    });

    it("is sent heartbeat comments while nothing happens", async () => {
      // Heartbeat every 40 ms: within 400 ms at least two have come (at 40 and 80 ms), with
      // ample room for a slow test machine.
      const { server, base } = await serve({ heartbeatMs: 40 });
      openAnswer(server, "42");
      const res = await streamFetch(base, "42", { proof: streamProof(KEY, "42") });
      const { text } = await readUntil(res, {
        until: (t) => parseSse(t).pings >= 2,
        timeoutMs: 400,
      });
      expect(parseSse(text).pings).to.be.at.least(2);
      expect(text).to.include(": ping\n\n");
    });

    it("has the response ended at the maximum connection time, so the reader reconnects", async () => {
      // STREAM_MAX_CONN_MS = 150: the server ends the response at 150 ms. The 2000 ms read limit
      // is far above it; ending before the limit is what the test shows.
      const { server, base } = await serve({ maxConnMs: 150 });
      openAnswer(server, "42");
      const started = Date.now();
      const res = await streamFetch(base, "42", { proof: streamProof(KEY, "42") });
      const { ended } = await readUntil(res, { timeoutMs: 2000 });
      const took = Date.now() - started;
      expect(ended).to.equal(true);
      expect(took).to.be.at.least(140); // 150 ms less 10 ms of timer granularity
      expect(took).to.be.below(1500);
    });

    it("replays a finished answer in its grace period and ends at once", async () => {
      const { server, base } = await serve();
      openAnswer(server, "42");
      sendFrames(server, "42", RUN_A, 0, 3);
      server.close("42", { run: RUN_A, outcome: "answered" });
      const res = await streamFetch(base, "42", { proof: streamProof(KEY, "42") });
      const { text, ended } = await readUntil(res);
      expect(parseSse(text).events).to.have.length(3);
      expect(ended).to.equal(true);
    });

    it("keeps following when a new run replaces the one it was reading", async () => {
      const { server, base } = await serve();
      openAnswer(server, "42", RUN_A);
      sendFrames(server, "42", RUN_A, 0, 1);
      const res = await streamFetch(base, "42", { proof: streamProof(KEY, "42") });
      const reading = readUntil(res, { until: (t) => t.includes(`${RUN_B}.1`) });
      await sleep(50);
      openAnswer(server, "42", RUN_B);
      sendFrames(server, "42", RUN_B, 0, 2);
      const ids = parseSse((await reading).text).events.map((e) => e.id);
      expect(ids).to.deep.equal([`${RUN_A}.0`, `${RUN_B}.0`, `${RUN_B}.1`]);
    });
  });

  describe("proof of key", () => {
    it("refuses a wrong proof with 403 and sends no frame", async () => {
      const { server, port } = await serve();
      openAnswer(server, "42");
      sendFrames(server, "42", RUN_A, 0, 3);
      const res = await rawRequest(port, {
        path: "/stream/42",
        headers: { [PROOF_HEADER]: streamProof(OTHER_KEY, "42") },
      });
      expect(res.status).to.equal(403);
      expect(JSON.parse(res.body)).to.deep.equal({ error: "proof" });
      expect(res.body).to.not.include(sealed());
      expect(res.body).to.not.include("id:");
    });

    it("refuses a wrong proof against a finished answer still in its grace period with 403 and no frame", async () => {
      // A finished answer is replayed to whoever shows its proof for STREAM_GRACE_MS; the proof
      // is checked in that state too, not only while the run is open.
      const { server, port } = await serve();
      openAnswer(server, "42");
      sendFrames(server, "42", RUN_A, 0, 3);
      server.close("42", { run: RUN_A, outcome: "answered" });
      const res = await rawRequest(port, {
        path: "/stream/42",
        headers: { [PROOF_HEADER]: streamProof(OTHER_KEY, "42") },
      });
      expect(res.status).to.equal(403);
      expect(res.body).to.equal(JSON.stringify({ error: "proof" }));
    });

    it("ends a reader admitted on one run, with none of the next run's frames, when that run opens with another proof", async () => {
      const { server, base } = await serve();
      openAnswer(server, "42", RUN_A, KEY);
      sendFrames(server, "42", RUN_A, 0, 1);
      const res = await streamFetch(base, "42", { proof: streamProof(KEY, "42") });
      expect(res.status).to.equal(200);
      const reading = readUntil(res, { timeoutMs: 2000 });
      await sleep(50);
      openAnswer(server, "42", RUN_B, OTHER_KEY);
      sendFrames(server, "42", RUN_B, 0, 2);
      const { text, ended } = await reading;
      expect(parseSse(text).events.map((e) => e.id)).to.deep.equal([`${RUN_A}.0`]);
      expect(text).to.not.include(RUN_B);
      expect(ended, "the server ended the response when the proof changed").to.equal(true);
    });

    it("opens nothing for a sink open whose expected proof is malformed", async () => {
      const { server, port } = await serve();
      server.open("42", { run: RUN_A, replica: "deadbeef", expectedProof: "not-a-proof" });
      sendFrames(server, "42", RUN_A, 0, 1);
      const res = await rawRequest(port, {
        path: "/stream/42",
        headers: { [PROOF_HEADER]: streamProof(KEY, "42") },
      });
      expect(res.status).to.equal(404);
      expect(JSON.parse(res.body)).to.deep.equal({ error: "not-open" });
    });

    it("does not let the proof for one answer open another", async () => {
      const { server, port } = await serve();
      openAnswer(server, "1");
      openAnswer(server, "2");
      sendFrames(server, "2", RUN_A, 0, 2);
      const res = await rawRequest(port, {
        path: "/stream/2",
        headers: { [PROOF_HEADER]: streamProof(KEY, "1") },
      });
      expect(res.status).to.equal(403);
      expect(res.body).to.not.include(sealed());
    });

    it("never sends a frame before the proof is checked, even for a frame sent mid-request", async () => {
      // A wrong proof against a live answer whose frames keep arriving: the response is the
      // refusal and nothing else.
      const { server, port } = await serve();
      openAnswer(server, "42");
      let seq = 0;
      const timer = setInterval(() => {
        sendFrames(server, "42", RUN_A, seq, 1);
        seq += 1;
      }, 1);
      try {
        await sleep(10);
        const res = await rawRequest(port, {
          path: "/stream/42",
          headers: { [PROOF_HEADER]: "A".repeat(43) },
        });
        expect(res.status).to.equal(403);
        expect(res.headers["content-type"]).to.equal("application/json");
        expect(res.body).to.equal(JSON.stringify({ error: "proof" }));
        expect(seq, "frames were arriving while the request was refused").to.be.greaterThan(0);
      } finally {
        clearInterval(timer);
      }
    });

    it("refuses a malformed answer id, a malformed proof and a missing proof with 400", async () => {
      const { port } = await serve();
      const proof = streamProof(KEY, "42");
      for (const path of ["/stream/042", "/stream/abc", "/stream/-1", "/stream/", "/stream/42/x"]) {
        const res = await rawRequest(port, { path, headers: { [PROOF_HEADER]: proof } });
        expect(res.status, path).to.equal(400);
        expect(JSON.parse(res.body)).to.deep.equal({ error: "bad-request" });
      }
      for (const bad of ["short", `${proof}=`, `${proof.slice(0, 42)}+`]) {
        const res = await rawRequest(port, {
          path: "/stream/42",
          headers: { [PROOF_HEADER]: bad },
        });
        expect(res.status, bad).to.equal(400);
      }
      const missing = await rawRequest(port, { path: "/stream/42" });
      expect(missing.status).to.equal(400);
    });

    it("refuses an unknown query", async () => {
      const { port } = await serve();
      const res = await rawRequest(port, {
        path: "/stream/42?mode=other",
        headers: { [PROOF_HEADER]: streamProof(KEY, "42") },
      });
      expect(res.status).to.equal(400);
    });
  });

  describe("answers it cannot serve", () => {
    it("says 404 with Retry-After: 2 for an answer not open yet", async () => {
      const { port } = await serve();
      const res = await rawRequest(port, {
        path: "/stream/42",
        headers: { [PROOF_HEADER]: streamProof(KEY, "42") },
      });
      expect(res.status).to.equal(404);
      expect(res.headers["retry-after"]).to.equal("2");
      expect(JSON.parse(res.body)).to.deep.equal({ error: "not-open" });
    });

    it("says 410 for an answer finished and dropped", async () => {
      // Grace of 30 ms; asked again 150 ms later, the frames are gone and the tombstone answers.
      const { server, port } = await serve({ graceMs: 30 });
      openAnswer(server, "42");
      sendFrames(server, "42", RUN_A, 0, 1);
      server.close("42", { run: RUN_A, outcome: "answered" });
      await sleep(150);
      const res = await rawRequest(port, {
        path: "/stream/42",
        headers: { [PROOF_HEADER]: streamProof(KEY, "42") },
      });
      expect(res.status).to.equal(410);
      expect(JSON.parse(res.body)).to.deep.equal({ error: "finished" });
    });

    it("says 503 with Retry-After for an answer the buffer could not hold", async () => {
      const { server, port } = await serve(
        {},
        { bufferLimits: { ...BUFFER_LIMITS, maxAnswerBytes: 10 } },
      );
      openAnswer(server, "42");
      sendFrames(server, "42", RUN_A, 0, 1);
      const res = await rawRequest(port, {
        path: "/stream/42",
        headers: { [PROOF_HEADER]: streamProof(KEY, "42") },
      });
      expect(res.status).to.equal(503);
      expect(res.headers["retry-after"]).to.equal(
        String(STREAM_REFUSALS.unavailable.retryAfterSeconds),
      );
    });
  });

  describe("connection caps", () => {
    it("refuses the fifth reader of one answer with 429 and Retry-After", async () => {
      const { server, base } = await serve({ maxConnPerAnswer: 4 });
      openAnswer(server, "42");
      const proof = streamProof(KEY, "42");
      const controllers = [];
      try {
        for (let i = 0; i < 4; i += 1) {
          const controller = new AbortController();
          controllers.push(controller);
          const res = await streamFetch(base, "42", { proof, signal: controller.signal });
          expect(res.status, `reader ${i + 1}`).to.equal(200);
        }
        const fifth = await streamFetch(base, "42", { proof });
        expect(fifth.status).to.equal(429);
        expect(fifth.headers.get("retry-after")).to.equal(
          String(STREAM_REFUSALS.busy.retryAfterSeconds),
        );
        expect(await fifth.json()).to.deep.equal({ error: "busy" });
      } finally {
        controllers.forEach((c) => c.abort());
      }
    });

    it("frees a reader's place when it goes away", async () => {
      const { server, base } = await serve({ maxConnPerAnswer: 1 });
      openAnswer(server, "42");
      const proof = streamProof(KEY, "42");
      const controller = new AbortController();
      await streamFetch(base, "42", { proof, signal: controller.signal });
      controller.abort();
      // The server sees the socket close within a few event-loop turns; 100 ms is ample.
      await sleep(100);
      const again = await streamFetch(base, "42", { proof });
      expect(again.status).to.equal(200);
      await again.body.cancel();
    });

    it("refuses past the total cap with 503", async () => {
      const { server, base } = await serve({ maxConnTotal: 2, maxConnPerAnswer: 2 });
      openAnswer(server, "1");
      openAnswer(server, "2");
      const controllers = [new AbortController(), new AbortController()];
      try {
        expect(
          (
            await streamFetch(base, "1", {
              proof: streamProof(KEY, "1"),
              signal: controllers[0].signal,
            })
          ).status,
        ).to.equal(200);
        expect(
          (
            await streamFetch(base, "2", {
              proof: streamProof(KEY, "2"),
              signal: controllers[1].signal,
            })
          ).status,
        ).to.equal(200);
        const third = await streamFetch(base, "2", { proof: streamProof(KEY, "2") });
        expect(third.status).to.equal(503);
        expect(third.headers.get("retry-after")).to.equal(
          String(STREAM_REFUSALS.unavailable.retryAfterSeconds),
        );
      } finally {
        controllers.forEach((c) => c.abort());
      }
    });
  });

  describe("socket limits for callers without a proof", () => {
    /** A raw socket that has connected; `whenClosed` resolves when the server closes it. */
    async function rawSocket(port) {
      const socket = net.connect(port, "127.0.0.1");
      socket.setEncoding("utf8");
      socket.text = "";
      socket.on("data", (chunk) => {
        socket.text += chunk;
      });
      socket.on("error", () => undefined);
      socket.whenClosed = new Promise((resolve) => socket.once("close", () => resolve(true)));
      await new Promise((resolve) => socket.once("connect", resolve));
      return socket;
    }

    const within = (promise, ms) =>
      Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(false), ms))]);

    const readerRequest = (id = "42") =>
      `GET /stream/${id} HTTP/1.1\r\nHost: 127.0.0.1\r\n${PROOF_HEADER}: ${streamProof(KEY, id)}\r\n\r\n`;

    it("sizes the socket cap from a descriptor budget, several times the reader cap", () => {
      // An assumed descriptor limit of 1024 less 256 kept for the oracle's own sockets and
      // files: 768 sockets, whatever the reader cap. The reader cap may be at most a third of
      // it, so the default 200 readers leave 568 sockets that proof-less callers must fill.
      expect(SOCKET_BUDGET).to.equal(768);
      for (const maxConnTotal of [1, 200, 256]) {
        const limits = httpLimitsFor(testConfig({ maxConnTotal }));
        expect(limits.maxConnections, `reader cap ${maxConnTotal}`).to.equal(SOCKET_BUDGET);
        expect(limits.maxConnections).to.be.at.least(3 * maxConnTotal);
      }
    });

    it("derives Node's own socket limits from the stream settings", () => {
      const config = testConfig();
      const limits = httpLimitsFor(config);
      // One preflight and the polls of one preflight lifetime: 600 s / 20 s + 1.
      expect(limits.maxRequestsPerSocket).to.equal(31);
      // The SSE retry (2 s) plus a second; Node then adds its 1 s buffer.
      expect(limits.keepAliveTimeoutMs).to.equal(STREAM_HTTP.sseRetryMs + 1000);
      expect(limits.keepAliveTimeoutBufferMs).to.equal(1000);
      // A socket that has not sent complete headers (nothing at all included) is closed within
      // 5.5 s, not Node's 60 + 30 s.
      expect(limits.headersTimeoutMs + limits.connectionsCheckingIntervalMs).to.be.at.most(5500);
      expect(limits.requestTimeoutMs).to.be.at.least(limits.headersTimeoutMs);
    });

    it("sets those limits on the server it creates", () => {
      const createServer = sinon.spy(http, "createServer");
      const config = testConfig();
      createStreamServer({ config });
      const server = createServer.firstCall.returnValue;
      const limits = httpLimitsFor(config);
      expect(server.maxConnections).to.equal(limits.maxConnections);
      expect(server.maxRequestsPerSocket).to.equal(limits.maxRequestsPerSocket);
      expect(server.keepAliveTimeout).to.equal(limits.keepAliveTimeoutMs);
      expect(server.keepAliveTimeoutBuffer).to.equal(limits.keepAliveTimeoutBufferMs);
      expect(server.headersTimeout).to.equal(limits.headersTimeoutMs);
      expect(server.requestTimeout).to.equal(limits.requestTimeoutMs);
      expect(server.connectionsCheckingInterval).to.equal(limits.connectionsCheckingIntervalMs);
    });

    it("closes sockets past the cap at once and keeps serving the readers it has", async () => {
      // A socket cap of 5 for the test (768 in production). Four readers hold four sockets, one
      // more socket fits, and each of the other nineteen of a flood of twenty is closed on
      // arrival, before a byte of it is parsed.
      const { server, port } = await serve(
        { maxConnTotal: 4, maxConnPerAnswer: 4 },
        { httpLimits: { maxConnections: 5 } },
      );
      openAnswer(server, "42");
      const readers = [];
      for (let i = 0; i < 4; i += 1) {
        const socket = await rawSocket(port);
        socket.write(
          `GET /stream/42 HTTP/1.1\r\nHost: 127.0.0.1\r\n${PROOF_HEADER}: ${streamProof(KEY, "42")}\r\n\r\n`,
        );
        readers.push(socket);
      }
      const started = Date.now();
      while (server.stats().connections < 4 && Date.now() - started < 1000) await sleep(10);
      expect(server.stats().connections).to.equal(4);

      const flood = [];
      try {
        for (let i = 0; i < 20; i += 1) flood.push(await rawSocket(port));
        const closed = await Promise.all(flood.map((socket) => within(socket.whenClosed, 1000)));
        expect(closed.filter(Boolean)).to.have.length(19);
        expect(server.stats().refusedSockets).to.equal(19);

        sendFrames(server, "42", RUN_A, 0, 1);
        const waitedFrom = Date.now();
        while (
          !readers.every((socket) => socket.text.includes(`id: ${RUN_A}.0`)) &&
          Date.now() - waitedFrom < 1000
        ) {
          await sleep(10);
        }
        for (const socket of readers) expect(socket.text).to.include(`id: ${RUN_A}.0`);
        expect(server.stats().connections).to.equal(4);
      } finally {
        [...readers, ...flood].forEach((socket) => socket.destroy());
      }
    });

    it("closes a socket that sends its headers too slowly within the headers bound", async () => {
      // Headers within 200 ms, checked every 50 ms: the socket is closed by about 250 ms; one
      // second leaves room for a slow machine and is far below Node's own 30 s check.
      const { port } = await serve(
        {},
        {
          httpLimits: {
            headersTimeoutMs: 200,
            requestTimeoutMs: 200,
            connectionsCheckingIntervalMs: 50,
          },
        },
      );
      const socket = await rawSocket(port);
      socket.write("GET /stream/42 HTTP/1.1\r\nHost: 127.0.0.1\r\n");
      const drip = setInterval(() => socket.write("X-Slow: 1\r\n"), 40);
      try {
        expect(await within(socket.whenClosed, 1000), "closed within the bound").to.equal(true);
      } finally {
        clearInterval(drip);
        socket.destroy();
      }
    });

    it("closes the socket after every answer but an admitted stream", async () => {
      // Refused, malformed, preflight, health and unknown-path requests all carry
      // `Connection: close` and lose their socket at once: no proof-less request keeps a place.
      const { server, port } = await serve();
      openAnswer(server, "42");
      const requests = [
        [`GET /stream/42 HTTP/1.1\r\n${PROOF_HEADER}: ${streamProof(OTHER_KEY, "42")}`, "403"],
        [`GET /stream/7 HTTP/1.1\r\n${PROOF_HEADER}: ${streamProof(KEY, "7")}`, "404"],
        ["GET /stream/42 HTTP/1.1", "400"],
        ["GET /stream/42?mode=other HTTP/1.1", "400"],
        [`OPTIONS /stream/42 HTTP/1.1\r\nOrigin: ${ALLOWED}`, "204"],
        ["GET /health HTTP/1.1", "200"],
        ["GET /nowhere HTTP/1.1", "404"],
      ];
      for (const [head, status] of requests) {
        const socket = await rawSocket(port);
        try {
          socket.write(`${head.replace(" HTTP/1.1", " HTTP/1.1\r\nHost: 127.0.0.1")}\r\n\r\n`);
          expect(await within(socket.whenClosed, 1000), `${head} closed`).to.equal(true);
          expect(socket.text.split("\r\n")[0], head).to.match(new RegExp(`^HTTP/1.1 ${status} `));
          expect(socket.text.toLowerCase(), head).to.include("connection: close");
        } finally {
          socket.destroy();
        }
      }
    });

    it("drops idle proof-less sockets that fill the pool within the bound, then admits a reader", async () => {
      // A socket cap of 10 and a 200 ms headers bound checked every 50 ms. Ten sockets that send
      // nothing fill the pool; each is closed by about 250 ms. A reader with a valid proof then
      // gets a place and is still served after the bound has passed again.
      const { server, port } = await serve(
        {},
        {
          httpLimits: {
            maxConnections: 10,
            headersTimeoutMs: 200,
            requestTimeoutMs: 200,
            connectionsCheckingIntervalMs: 50,
          },
        },
      );
      openAnswer(server, "42");
      const idle = [];
      try {
        for (let i = 0; i < 10; i += 1) idle.push(await rawSocket(port));
        const closed = await Promise.all(idle.map((socket) => within(socket.whenClosed, 1000)));
        expect(closed.every(Boolean), "every idle socket closed within the bound").to.equal(true);

        const reader = await rawSocket(port);
        try {
          reader.write(readerRequest());
          await sleep(500);
          sendFrames(server, "42", RUN_A, 0, 1);
          const waitedFrom = Date.now();
          while (!reader.text.includes(`id: ${RUN_A}.0`) && Date.now() - waitedFrom < 1000) {
            await sleep(10);
          }
          expect(reader.text.split("\r\n")[0]).to.equal("HTTP/1.1 200 OK");
          expect(reader.text).to.include(`id: ${RUN_A}.0`);
          expect(server.stats().connections).to.equal(1);
        } finally {
          reader.destroy();
        }
      } finally {
        idle.forEach((socket) => socket.destroy());
      }
    });

    it("admits a reader while idle sockets are still within their bound, if the cap has room", async () => {
      const { server, port } = await serve(
        {},
        { httpLimits: { maxConnections: 10, headersTimeoutMs: 2000, requestTimeoutMs: 2000 } },
      );
      openAnswer(server, "42");
      const idle = [];
      try {
        for (let i = 0; i < 8; i += 1) idle.push(await rawSocket(port));
        const reader = await rawSocket(port);
        try {
          reader.write(readerRequest());
          const waitedFrom = Date.now();
          while (!reader.text.includes("\r\n\r\n") && Date.now() - waitedFrom < 1000) {
            await sleep(10);
          }
          expect(reader.text.split("\r\n")[0]).to.equal("HTTP/1.1 200 OK");
          expect(server.stats().connections).to.equal(1);
          expect(server.stats().refusedSockets).to.equal(0);
        } finally {
          reader.destroy();
        }
      } finally {
        idle.forEach((socket) => socket.destroy());
      }
    });

    it("leaves a live event stream open past the header, request and keep-alive timeouts", async () => {
      // Every socket timeout at 100 ms or less, checked every 20 ms; the reader is still served
      // 700 ms later. Node checks the header and request timeouts only until a request is
      // complete, and the keep-alive timeout only after a response has finished.
      const { server, base } = await serve(
        {},
        {
          httpLimits: {
            headersTimeoutMs: 100,
            requestTimeoutMs: 100,
            connectionsCheckingIntervalMs: 20,
            keepAliveTimeoutMs: 50,
            keepAliveTimeoutBufferMs: 0,
          },
        },
      );
      openAnswer(server, "42");
      const res = await streamFetch(base, "42", { proof: streamProof(KEY, "42") });
      expect(res.status).to.equal(200);
      const reading = readUntil(res, { until: (t) => t.includes(`${RUN_A}.0`), timeoutMs: 3000 });
      await sleep(700);
      sendFrames(server, "42", RUN_A, 0, 1);
      const { text, ended } = await reading;
      expect(parseSse(text).events.map((e) => e.id)).to.deep.equal([`${RUN_A}.0`]);
      expect(ended).to.equal(false);
    });
  });

  describe("poll mode", () => {
    it("writes what is buffered after the cursor and ends at once", async () => {
      const { server, base } = await serve();
      openAnswer(server, "42");
      sendFrames(server, "42", RUN_A, 0, 3);
      const started = Date.now();
      const res = await streamFetch(base, "42", {
        proof: streamProof(KEY, "42"),
        mode: "poll",
        lastEventId: `${RUN_A}.0`,
      });
      const { text, ended } = await readUntil(res, { timeoutMs: 2000 });
      expect(ended).to.equal(true);
      // "At once": far below the 20 s poll wait.
      expect(Date.now() - started).to.be.below(1000);
      expect(parseSse(text).events.map((e) => e.id)).to.deep.equal([`${RUN_A}.1`, `${RUN_A}.2`]);
    });

    it("with nothing new, waits for the first new frame and ends after it", async () => {
      const { server, base } = await serve();
      openAnswer(server, "42");
      const res = await streamFetch(base, "42", { proof: streamProof(KEY, "42"), mode: "poll" });
      const reading = readUntil(res, { timeoutMs: 3000 });
      await sleep(50);
      sendFrames(server, "42", RUN_A, 0, 1);
      const { text, ended } = await reading;
      expect(ended).to.equal(true);
      expect(parseSse(text).events.map((e) => e.id)).to.deep.equal([`${RUN_A}.0`]);
    });

    it("with nothing new, ends after the poll wait", async () => {
      // Poll wait set to 100 ms for the test (the contract's is STREAM_HTTP.pollWaitMs = 20 s).
      expect(STREAM_HTTP.pollWaitMs).to.equal(20000);
      const { server, base } = await serve({}, { pollWaitMs: 100 });
      openAnswer(server, "42");
      const started = Date.now();
      const res = await streamFetch(base, "42", { proof: streamProof(KEY, "42"), mode: "poll" });
      const { text, ended } = await readUntil(res, { timeoutMs: 2000 });
      expect(ended).to.equal(true);
      expect(Date.now() - started).to.be.at.least(90); // 100 ms less timer granularity
      expect(parseSse(text).events).to.deep.equal([]);
    });
  });

  describe("a reader that does not read", () => {
    it("is destroyed once its socket has not drained, and a frame sent meanwhile returns in under 5 ms", async () => {
      // Backpressure limit 100 ms for the test (10 s in production). The answer's byte cap is
      // raised so the buffer, not the cap, is what fills: the reader's socket and the kernel's
      // buffers fill first, write() returns false, and 100 ms later the connection is destroyed.
      const { server, port } = await serve(
        {},
        {
          backpressureMs: 100,
          bufferLimits: {
            ...BUFFER_LIMITS,
            maxAnswerBytes: 512 * 1024 * 1024,
            maxTotalBytes: 512 * 1024 * 1024,
          },
        },
      );
      openAnswer(server, "42");
      const socket = net.connect(port, "127.0.0.1");
      await new Promise((resolve) => socket.once("connect", resolve));
      socket.write(
        `GET /stream/42 HTTP/1.1\r\nHost: 127.0.0.1\r\n${PROOF_HEADER}: ${streamProof(KEY, "42")}\r\n\r\n`,
      );
      // A paused socket reads nothing, so it never sees the close either: the server's own
      // count of connections is what shows it was dropped.
      socket.pause();
      await sleep(50);
      expect(server.stats().connections).to.equal(1);

      // Frames of 64 KiB every 2 ms: the reader's socket and the kernel's buffers fill within a
      // few dozen frames, after which write() keeps returning false and nothing drains. Each
      // frame call made while the reader is backed up is timed.
      const big = sealed(64 * 1024);
      let seq = 0;
      let backedUpCalls = 0;
      let slowestMs = 0;
      const started = Date.now();
      while (server.stats().connections > 0 && Date.now() - started < 5000) {
        const backedUp = server.stats().waitingToDrain > 0;
        const t0 = process.hrtime.bigint();
        server.frame("42", { run: RUN_A, seq, ciphertext: big });
        const tookMs = Number(process.hrtime.bigint() - t0) / 1e6;
        if (backedUp) {
          backedUpCalls += 1;
          slowestMs = Math.max(slowestMs, tookMs);
        }
        seq += 1;
        await sleep(2);
      }
      expect(server.stats().connections, "the server destroyed the connection").to.equal(0);
      expect(server.stats().waitingToDrain, "the destroyed reader is no longer counted").to.equal(
        0,
      );
      socket.destroy();
      // Destroyed well inside the 5 s loop limit: 100 ms after its socket stopped draining.
      expect(Date.now() - started).to.be.below(5000);
      expect(backedUpCalls, "frames were sent while the reader was backed up").to.be.greaterThan(0);
      expect(slowestMs).to.be.below(5);
    });

    it("may queue one run's worth of bytes, not two answers' worth", () => {
      // One run at its longest (contract limits): a reset, then per attempt an attempt frame, a
      // sources frame and 64 steps, then the answer and done: 1 + 4 x 66 + 2 = 267 frames.
      const maxFrames = 1 + LIMITS.maxAttempts * (2 + LIMITS.maxStepsPerAttempt) + 2;
      expect(maxFrames).to.equal(267);
      const cap = readerQueueCap(BUFFER_LIMITS);
      // Room for a whole answer's replay with its SSE lines, the retry line and a few pings.
      expect(cap).to.be.at.least(BUFFER_LIMITS.maxAnswerBytes + maxFrames * 50);
      // About 1.015 MiB, where it was 2 MiB: 200 readers hold at most about 203 MiB.
      expect(cap).to.be.below(BUFFER_LIMITS.maxAnswerBytes * 1.05);
    });

    it("is destroyed once its queued bytes pass the cap, long before the drain timer", async () => {
      // Drain timer 60 s, so only the byte cap can end this reader inside the 4 s loop. Each run
      // stays under the answer's 256 KiB cap (15 frames of 16 KiB), and a new run on the same
      // proof follows on the same response, so the queue grows run after run while the reader,
      // paused, reads nothing. The kernel's buffers take some first; the cap ends it after that.
      const maxAnswerBytes = 256 * 1024;
      const { server, port } = await serve(
        {},
        {
          backpressureMs: 60000,
          bufferLimits: { ...BUFFER_LIMITS, maxAnswerBytes, maxTotalBytes: 64 * 1024 * 1024 },
        },
      );
      const runId = (n) => n.toString(16).padStart(16, "0");
      openAnswer(server, "42", runId(0));
      const socket = net.connect(port, "127.0.0.1");
      await new Promise((resolve) => socket.once("connect", resolve));
      socket.write(
        `GET /stream/42 HTTP/1.1\r\nHost: 127.0.0.1\r\n${PROOF_HEADER}: ${streamProof(KEY, "42")}\r\n\r\n`,
      );
      socket.pause();
      await sleep(50);
      expect(server.stats().connections).to.equal(1);

      const frame = sealed(16 * 1024);
      const started = Date.now();
      let run = 0;
      try {
        while (server.stats().connections > 0 && Date.now() - started < 4000) {
          for (let seq = 0; seq < 15; seq += 1) {
            server.frame("42", { run: runId(run), seq, ciphertext: frame });
          }
          run += 1;
          openAnswer(server, "42", runId(run));
          await sleep(2);
        }
        expect(server.stats().connections, "destroyed by the byte cap").to.equal(0);
        expect(Date.now() - started).to.be.below(4000);
      } finally {
        socket.destroy();
      }
    });
  });

  describe("what it counts", () => {
    /** Sink info whose `run` throws an error of the given code when the server reads it. */
    const throwingInfo = (code) => ({
      get run() {
        const error = new Error("unreadable");
        error.code = code;
        throw error;
      },
    });
    const HOUR_MS = 60 * 60 * 1000;

    it("counts every failure and logs each kind at most once an hour, by kind only", async () => {
      let nowMs = 1000000;
      const logged = sinon.stub(console, "error");
      const { server } = await serve({}, { now: () => nowMs });

      server.frame("42", throwingInfo("EONE"));
      server.frame("42", throwingInfo("EONE"));
      expect(server.stats().failures).to.equal(2);
      expect(logged.callCount, "the second of a kind within the hour is not logged").to.equal(1);
      expect(logged.firstCall.args.join(" ")).to.include("EONE");
      expect(logged.firstCall.args.join(" ")).to.not.include("unreadable");

      server.frame("42", throwingInfo("ETWO"));
      expect(logged.callCount, "another kind is logged").to.equal(2);

      nowMs += HOUR_MS - 1;
      server.frame("42", throwingInfo("EONE"));
      expect(logged.callCount, "still within the hour").to.equal(2);
      nowMs += 1;
      server.frame("42", throwingInfo("EONE"));
      expect(logged.callCount, "an hour after it was last logged").to.equal(3);
      expect(server.stats().failures).to.equal(5);
    });

    it("carries the opens and frames the buffer refused in its stats", async () => {
      const { server } = await serve({}, { bufferLimits: { ...BUFFER_LIMITS, maxOpenAnswers: 1 } });
      openAnswer(server, "1");
      openAnswer(server, "2"); // no room for a second answer
      sendFrames(server, "1", RUN_A, 0, 1);
      server.frame("1", { run: RUN_A, seq: 5, ciphertext: sealed() }); // a gap
      server.frame("2", { run: RUN_A, seq: 0, ciphertext: sealed() }); // never opened
      expect(server.stats()).to.include({ refusedOpens: 1, refusedAppends: 2, failures: 0 });
    });
  });

  describe("CORS", () => {
    it("echoes an allowed origin on a stream response and on a refusal, with Vary and Retry-After exposed", async () => {
      const { server, port } = await serve();
      openAnswer(server, "42");
      server.close("42", { run: RUN_A, outcome: "answered" });
      const ok = await rawRequest(port, {
        path: "/stream/42",
        headers: { Origin: ALLOWED, [PROOF_HEADER]: streamProof(KEY, "42") },
      });
      expect(ok.status).to.equal(200);
      expect(ok.headers["access-control-allow-origin"]).to.equal(ALLOWED);
      expect(ok.headers.vary).to.equal("Origin");
      expect(ok.headers["access-control-expose-headers"]).to.equal("Retry-After");
      expect(ok.headers["access-control-allow-credentials"]).to.equal(undefined);

      const refused = await rawRequest(port, {
        path: "/stream/7",
        headers: { Origin: ALLOWED, [PROOF_HEADER]: streamProof(KEY, "7") },
      });
      expect(refused.status).to.equal(404);
      expect(refused.headers["access-control-allow-origin"]).to.equal(ALLOWED);
    });

    it("gives a disallowed origin no CORS headers at all, but still Vary: Origin", async () => {
      const { port } = await serve();
      for (const origin of [
        "https://evil.example",
        `${ALLOWED}/`,
        "null",
        `${ALLOWED}.evil.example`,
      ]) {
        const res = await rawRequest(port, {
          path: "/stream/42",
          headers: { Origin: origin, [PROOF_HEADER]: streamProof(KEY, "42") },
        });
        expect(res.headers["access-control-allow-origin"], origin).to.equal(undefined);
        expect(res.headers["access-control-expose-headers"], origin).to.equal(undefined);
        expect(res.headers.vary).to.equal("Origin");
      }
    });

    it("answers the preflight for an allowed origin", async () => {
      const { port } = await serve();
      const res = await rawRequest(port, {
        method: "OPTIONS",
        path: "/stream/42",
        headers: {
          Origin: ALLOWED,
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "x-senseai-stream-proof, last-event-id",
        },
      });
      expect(res.status).to.equal(204);
      expect(res.headers["access-control-allow-origin"]).to.equal(ALLOWED);
      expect(res.headers["access-control-allow-methods"]).to.equal("GET");
      expect(res.headers["access-control-allow-headers"]).to.equal(
        "X-SenseAI-Stream-Proof, Last-Event-ID",
      );
      expect(res.headers["access-control-max-age"]).to.equal("600");
      expect(res.headers["access-control-allow-credentials"]).to.equal(undefined);
      expect(res.headers.vary).to.equal("Origin");
    });

    it("answers the preflight of a disallowed origin without CORS headers", async () => {
      const { port } = await serve();
      const res = await rawRequest(port, {
        method: "OPTIONS",
        path: "/stream/42",
        headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "GET" },
      });
      expect(res.headers["access-control-allow-origin"]).to.equal(undefined);
      expect(res.headers["access-control-allow-methods"]).to.equal(undefined);
    });
  });

  describe("everything else", () => {
    it("answers /health with 200 and {ok:true}, never to be cached", async () => {
      const { base } = await serve();
      const res = await fetch(`${base}${STREAM_HTTP.healthPath}`);
      expect(res.status).to.equal(200);
      expect(res.headers.get("cache-control")).to.equal("no-store");
      expect(await res.json()).to.deep.equal({ ok: true });
    });

    it("answers any other path or method with a bare 404", async () => {
      const { port } = await serve();
      for (const [method, path] of [
        ["GET", "/"],
        ["GET", "/streams/42"],
        ["GET", "/health/x"],
        ["POST", "/health"],
        ["OPTIONS", "/health"],
        ["POST", "/stream/42"],
        ["DELETE", "/stream/42"],
        ["HEAD", "/stream/42"],
      ]) {
        const res = await rawRequest(port, { method, path });
        expect(res.status, `${method} ${path}`).to.equal(404);
        expect(res.body, `${method} ${path}`).to.equal("");
      }
    });

    it("refuses a request with a body cheaply, without reading it, and closes the connection", async () => {
      const { server, port } = await serve();
      openAnswer(server, "42");
      const res = await rawRequest(port, {
        path: "/stream/42",
        headers: { [PROOF_HEADER]: streamProof(KEY, "42"), "Content-Length": "5" },
        body: "hello",
      });
      expect(res.status).to.equal(400);
      expect(res.headers.connection).to.equal("close");
      expect(res.body).to.not.include(sealed());
    });

    it("refuses an over-long URL cheaply", async () => {
      const { port } = await serve();
      const res = await rawRequest(port, { path: `/stream/${"1".repeat(2000)}` });
      expect(res.status).to.equal(400);
      expect(res.headers.connection).to.equal("close");
    });

    it("answers 503 when the request handler throws, and the process carries on", async () => {
      // The buffer's lookup is made to throw inside the request handler. Uncaught there, it
      // would reach the process as an uncaughtException (which mocha reports as a failure).
      const realBuffer = require("../src/stream/frameBuffer");
      const brokenBuffer = {
        ...realBuffer,
        createFrameBuffer: (options) => ({
          ...realBuffer.createFrameBuffer(options),
          lookup: () => {
            throw new TypeError("lookup broke");
          },
        }),
      };
      const { createStreamServer: createWithBrokenLookup } = proxyquire(
        "../src/stream/streamServer",
        { "./frameBuffer": brokenBuffer },
      );
      sinon.stub(console, "error");
      const uncaught = sinon.spy();
      process.on("uncaughtException", uncaught);
      try {
        const server = createWithBrokenLookup({ config: testConfig() });
        running.push(server);
        const { port } = await server.listen({ port: 0, host: "127.0.0.1" });
        const res = await rawRequest(port, {
          path: "/stream/42",
          headers: { [PROOF_HEADER]: streamProof(KEY, "42") },
        });
        expect(res.status).to.equal(503);
        expect(res.headers.connection).to.equal("close");
        expect((await rawRequest(port, { path: STREAM_HTTP.healthPath })).status).to.equal(200);
        expect(uncaught.called).to.equal(false);
      } finally {
        process.removeListener("uncaughtException", uncaught);
      }
    });

    it("answers 503 to a request whose headers complete while shutting down", async () => {
      const { server, port } = await serve();
      openAnswer(server, "42");
      const socket = net.connect(port, "127.0.0.1");
      await new Promise((resolve) => socket.once("connect", resolve));
      let reply = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        reply += chunk;
      });
      // The request has begun, so the connection is not idle and shutdown leaves it open.
      socket.write("GET /stream/42 HTTP/1.1\r\nHost: 127.0.0.1\r\n");
      await sleep(30);
      const closing = server.shutdown();
      socket.write(`${PROOF_HEADER}: ${streamProof(KEY, "42")}\r\n\r\n`);
      const started = Date.now();
      while (!reply.includes("}") && Date.now() - started < 1500) await sleep(10);
      socket.destroy();
      await closing;
      expect(reply.split("\r\n")[0]).to.equal("HTTP/1.1 503 Service Unavailable");
      expect(reply).to.include(JSON.stringify({ error: "unavailable" }));
    });

    it("clears a reader's heartbeat and lifetime timers when it goes away", async () => {
      // Distinct delays pick the reader's two timers out of every other timer in the process.
      const heartbeatMs = 4321;
      const maxConnMs = 98765;
      const setIntervalSpy = sinon.spy(global, "setInterval");
      const setTimeoutSpy = sinon.spy(global, "setTimeout");
      const clearIntervalSpy = sinon.spy(global, "clearInterval");
      const clearTimeoutSpy = sinon.spy(global, "clearTimeout");
      const { server, base } = await serve({ heartbeatMs, maxConnMs });
      openAnswer(server, "42");
      const controller = new AbortController();
      const res = await streamFetch(base, "42", {
        proof: streamProof(KEY, "42"),
        signal: controller.signal,
      });
      expect(res.status).to.equal(200);
      const heartbeat = setIntervalSpy.getCalls().find((c) => c.args[1] === heartbeatMs);
      const lifetime = setTimeoutSpy.getCalls().find((c) => c.args[1] === maxConnMs);
      expect(heartbeat, "the reader's heartbeat was set").to.not.equal(undefined);
      expect(lifetime, "the reader's lifetime timer was set").to.not.equal(undefined);
      controller.abort();
      const started = Date.now();
      while (server.stats().connections > 0 && Date.now() - started < 1000) await sleep(10);
      expect(server.stats().connections).to.equal(0);
      expect(clearIntervalSpy.calledWith(heartbeat.returnValue)).to.equal(true);
      expect(clearTimeoutSpy.calledWith(lifetime.returnValue)).to.equal(true);
    });

    it("ends every open stream and stops listening on shutdown", async () => {
      const { server, base } = await startServer();
      openAnswer(server, "42");
      const res = await streamFetch(base, "42", { proof: streamProof(KEY, "42") });
      const reading = readUntil(res, { timeoutMs: 3000 });
      await sleep(30);
      await server.shutdown();
      const { ended } = await reading;
      expect(ended).to.equal(true);
      let refused = false;
      await fetch(`${base}/health`).catch(() => {
        refused = true;
      });
      expect(refused).to.equal(true);
    });
  });

  describe("start-up", () => {
    function fakeProcess() {
      const proc = new EventEmitter();
      proc.pid = 4242;
      proc.kill = sinon.stub();
      return proc;
    }

    it("with the stream disabled opens no port, sets no sink and listens for no signal", async () => {
      const createServer = sinon.spy(http, "createServer");
      const setSink = sinon.spy();
      const proc = fakeProcess();
      const result = await startStreamFromEnv({
        env: { NETWORK_NAME: "baseSepolia", STREAM_ENABLED: "false" },
        setSink,
        processRef: proc,
      });
      expect(result).to.equal(null);
      expect(createServer.called).to.equal(false);
      expect(setSink.called).to.equal(false);
      expect(proc.listenerCount("SIGTERM")).to.equal(0);
    });

    it("when enabled (the default) serves /health, becomes the sink, and closes before re-raising SIGTERM", async () => {
      const setSink = sinon.spy();
      const proc = fakeProcess();
      const server = await startStreamFromEnv({
        env: { NETWORK_NAME: "baseSepolia" },
        setSink,
        processRef: proc,
        listen: { port: 0, host: "127.0.0.1" },
      });
      running.push(server);
      expect(setSink.calledOnceWith(server)).to.equal(true);
      expect(isSink(server)).to.equal(true);
      const base = `http://127.0.0.1:${server.address().port}`;
      expect((await fetch(`${base}/health`)).status).to.equal(200);

      expect(proc.listenerCount("SIGTERM")).to.equal(1);
      proc.emit("SIGTERM");
      // Shutdown is awaited, bounded, then the signal is raised again for its default action.
      await sleep(100);
      expect(proc.kill.calledOnceWith(4242, "SIGTERM")).to.equal(true);
      expect(proc.listenerCount("SIGTERM")).to.equal(0);
      let refused = false;
      await fetch(`${base}/health`).catch(() => {
        refused = true;
      });
      expect(refused).to.equal(true);
    });

    it("answers without a stream when the port cannot be had", async () => {
      const blocker = net.createServer();
      await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
      const { port } = blocker.address();
      const setSink = sinon.spy();
      const proc = fakeProcess();
      const warn = sinon.stub(console, "error");
      try {
        const result = await startStreamFromEnv({
          env: { NETWORK_NAME: "baseSepolia" },
          setSink,
          processRef: proc,
          listen: { port, host: "127.0.0.1" },
        });
        expect(result).to.equal(null);
        expect(setSink.called).to.equal(false);
        expect(proc.listenerCount("SIGTERM")).to.equal(0);
        expect(warn.called).to.equal(true);
        expect(warn.firstCall.args.join(" ")).to.not.include(String(port));
      } finally {
        warn.restore();
        await new Promise((resolve) => blocker.close(resolve));
      }
    });

    it("is started by index.js before the oracle starts, and handed the oracle's setStreamSink", () => {
      const index = readFileSync(join(__dirname, "..", "src", "index.js"), "utf8");
      const startAt = index.search(
        /await\s+startStreamFromEnv\(\{[^}]*setSink:\s*oracle\.setStreamSink/,
      );
      const oracleStartAt = index.indexOf("await oracle.start()");
      expect(startAt, "index.js starts the stream server").to.be.greaterThan(-1);
      expect(oracleStartAt).to.be.greaterThan(startAt);
    });
  });
});
