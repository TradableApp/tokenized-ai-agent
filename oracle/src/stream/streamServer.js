const http = require("node:http");
const crypto = require("node:crypto");

const {
  LIMITS,
  STREAM_HTTP,
  STREAM_REFUSALS,
  SSE_EVENT_NAME,
  isAnswerMessageId,
  isProof,
  isRun,
  parseSseEventId,
  sseEventId,
} = require("./streamContract");
const { createFrameBuffer, BUFFER_LIMITS } = require("./frameBuffer");
const { readStreamConfig, SOCKET_BUDGET } = require("./streamConfig");
const { errorKind } = require("../errorDescription");

/**
 * The live reasoning stream server: a `node:http` adapter over the frame buffer that serves
 * each answer's sealed frames to a reader who proves it holds the conversation's key.
 *
 *   GET /stream/{answerMessageId}[?mode=poll]   X-SenseAI-Stream-Proof, optional Last-Event-ID
 *   GET /health                                  {"ok":true}
 *   OPTIONS /stream/…                            the CORS preflight
 *
 * It is also the answer path's sink (open, frame, close; see streamContract.js), so the oracle
 * hands it frames directly. The server never holds a key: the answer path computes the expected
 * proof and the server compares it in constant time. Frames are ciphertext; the server cannot
 * read them and never needs to.
 *
 * WHY NOTHING HERE CAN SLOW AN ANSWER. The sink methods are synchronous and guarded: a frame is
 * appended to memory and written to each reader's socket with a non-blocking write. A reader
 * whose socket has not drained `backpressureMs` after a write was refused is destroyed, and one
 * that has more than one run's worth of bytes queued (`readerQueueCap`) is destroyed at once, so
 * a slow or hostile reader costs bounded memory and never time on the answer path.
 *
 * WHY IT LOGS SO LITTLE. This is a network surface inside the TEE and the machine's logs are
 * kept. No request is logged; nothing a reader sent (its address, its headers, the answer id it
 * asked for) appears in a log line or an error (oracle/test/streamLogging.test.js). Failures are
 * described by kind only (`errorKind`).
 *
 * WHAT IT DOES NOT DO (by plan): TLS (the ROFL proxy's job, measured in Phase 0), per-address
 * rate limits (the reader's address is never read, and behind the proxy every caller may share
 * one; see `httpLimitsFor`), and a relay for when the proxy cannot carry a stream.
 */

/** A reader whose socket has not drained this long after a refused write is destroyed. */
const BACKPRESSURE_MS = 10000;
/** `/stream/` + a 78-digit id + `?mode=poll` is under 100; anything longer is not a request we serve. */
const MAX_REQUEST_TARGET_CHARS = 128;
/** Request line and headers together; a browser's GET with these headers is far below it. */
const MAX_HEADER_BYTES = 8192;
const MAX_HEADERS_COUNT = 50;
/**
 * The time a socket has to send its request line and headers, counted from when it connected
 * (a socket that sends nothing at all is closed by it too). A browser, or the proxy in front of
 * the server, sends both at once; 5 s keeps a place held without a proof short.
 */
const HEADERS_TIMEOUT_MS = 5000;
/**
 * A request with a body is refused, so a request we serve is complete with its headers. Node
 * requires requestTimeout >= headersTimeout. Neither applies once the request is complete: Node's
 * parser leaves the list these timeouts are checked against when the message completes, so a
 * long event stream is never cut by them.
 */
const REQUEST_TIMEOUT_MS = HEADERS_TIMEOUT_MS;
/**
 * How often Node checks the two timeouts above. Its default, 30 s, would let a socket that never
 * finishes its headers live up to 5 + 30 s; at 0.5 s it is closed within 5.5 s. Each check walks
 * only the connections still receiving a request, which are at most `maxConnections`.
 */
const CONNECTIONS_CHECK_MS = 500;
/**
 * A reader reconnects `sseRetryMs` (2 s) after a stream ends, and a 404 tells it to retry after
 * 2 s too. A keep-alive socket idle a second longer than that is not about to be reused.
 */
const KEEP_ALIVE_HEADROOM_MS = 1000;
/**
 * What Node (24.6 and later) adds to keepAliveTimeout before it destroys an idle socket; set to
 * its default here so the bound is written down: an idle socket lives at most 2 + 1 + 1 = 4 s.
 */
const KEEP_ALIVE_BUFFER_MS = 1000;
const MS_PER_SECOND = 1000;
/** A kind of server failure is logged again at most this often; every one is counted. */
const FAILURE_LOG_INTERVAL_MS = 60 * 60 * 1000;
/** The kinds whose last log time is remembered; errorKind gives a short word, so few occur. */
const MAX_FAILURE_KINDS = 32;
/** How long shutdown waits for responses to finish before closing every socket. */
const SHUTDOWN_GRACE_MS = 2000;

const PROOF_HEADER = STREAM_HTTP.proofHeader.toLowerCase();
const LAST_EVENT_ID_HEADER = STREAM_HTTP.lastEventIdHeader.toLowerCase();
const PREFLIGHT_ALLOWED_HEADERS = `${STREAM_HTTP.proofHeader}, ${STREAM_HTTP.lastEventIdHeader}`;
const MODE_QUERY_PREFIX = "mode=";
const CLOSE = Object.freeze({ Connection: "close" });
const PING = ": ping\n\n";

function proofMatches(given, expected) {
  if (typeof expected !== "string" || expected.length !== given.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given, "utf-8"), Buffer.from(expected, "utf-8"));
}

function hasBody(req) {
  const length = req.headers["content-length"];
  return (length !== undefined && length !== "0") || req.headers["transfer-encoding"] !== undefined;
}

function eventText(frame) {
  return `id: ${sseEventId(frame.run, frame.seq)}\nevent: ${SSE_EVENT_NAME}\ndata: ${frame.ciphertext}\n\n`;
}

const RETRY_LINE = `retry: ${STREAM_HTTP.sseRetryMs}\n\n`;
/** The SSE lines around one frame's ciphertext at their longest (a 16-digit seq): 59 bytes. */
const EVENT_OVERHEAD_BYTES = eventText({
  run: "0".repeat(16),
  seq: Number.MAX_SAFE_INTEGER,
  ciphertext: "",
}).length;
/**
 * The most frames one run sends (contract limits): a reset; per attempt an attempt frame, a
 * sources frame and up to `maxStepsPerAttempt` steps; then the answer and done. 267 today.
 */
const MAX_FRAMES_PER_RUN = 1 + LIMITS.maxAttempts * (2 + LIMITS.maxStepsPerAttempt) + 2;
/**
 * Pings a backed-up reader may be sent before the drain timer ends it: one per heartbeat, and the
 * heartbeat is longer than the drain wait by default. A few more allowed for other settings.
 */
const PINGS_ALLOWED = 8;

/**
 * The most bytes one reader may have queued (written, not yet taken by the kernel) before it is
 * destroyed: the longest run's whole replay with its SSE lines, the retry line and a few pings,
 * so a reader that joins a full finished answer is never refused for the replay itself. About
 * 1 MiB + 267 x 59 B + 77 B = 1,064,406 B (about 1.015 MiB) with the default 1 MiB answer cap.
 *
 * WORST CASE. Every reader at the cap at once: `maxConnTotal` x this, about 203 MiB at the
 * default 200 readers, for at most `backpressureMs` (10 s) each, on top of the buffer's own
 * 64 MiB. It was twice the answer cap per reader (about 400 MiB). A reader still taking in one
 * run when the next run starts on its response may pass the cap and is then destroyed; it
 * reconnects and replays the new run.
 *
 * @param {{ maxAnswerBytes: number }} bufferLimits
 */
function readerQueueCap(bufferLimits) {
  return (
    bufferLimits.maxAnswerBytes +
    MAX_FRAMES_PER_RUN * EVENT_OVERHEAD_BYTES +
    RETRY_LINE.length +
    PINGS_ALLOWED * PING.length
  );
}

/**
 * Node's own socket limits. They bound what a caller without a proof can hold in the process
 * that answers paid prompts: sockets (so descriptors), requests on one socket, idle keep-alive
 * time and time to send headers. A socket past `maxConnections` is closed by `net` on arrival,
 * before the HTTP layer allocates a parser for it, so it costs no parsing.
 *
 * The socket cap is the descriptor budget (SOCKET_BUDGET in streamConfig.js, 768), not the
 * reader cap: the reader cap (STREAM_MAX_CONN_TOTAL, at most a third of the budget) is checked
 * after the proof, and every answer but an admitted stream closes its socket, so a caller
 * without a proof holds a place for at most the headers bound (5.5 s) and must keep reopening
 * sockets faster than that to keep key holders out. There is deliberately no limit per source
 * address: the reader's address is never read (oracle/test/streamLogging.test.js guards it),
 * and behind the ROFL proxy every caller may arrive from the proxy's one address anyway.
 *
 * Node's documented behaviour (v24, read 2026-11-21): nodejs.org/docs/latest-v24.x/api/http.html
 * (headersTimeout, requestTimeout, connectionsCheckingInterval, keepAliveTimeout,
 * keepAliveTimeoutBuffer, maxRequestsPerSocket) and .../api/net.html (maxConnections, 'drop').
 * Checked on Node 24: headersTimeout also closes a socket that connects and sends nothing.
 */
function httpLimitsFor() {
  return Object.freeze({
    maxConnections: SOCKET_BUDGET,
    // One preflight, then the polls of one preflight lifetime (600 s / 20 s = 30): a polling
    // reader's socket is replaced about once per preflight, and one socket cannot carry an
    // unbounded run of pipelined requests (past the limit Node answers 503).
    maxRequestsPerSocket:
      Math.ceil((STREAM_HTTP.preflightMaxAgeSeconds * MS_PER_SECOND) / STREAM_HTTP.pollWaitMs) + 1,
    keepAliveTimeoutMs: STREAM_HTTP.sseRetryMs + KEEP_ALIVE_HEADROOM_MS,
    keepAliveTimeoutBufferMs: KEEP_ALIVE_BUFFER_MS,
    headersTimeoutMs: HEADERS_TIMEOUT_MS,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    connectionsCheckingIntervalMs: CONNECTIONS_CHECK_MS,
  });
}

/**
 * @param {object} options
 * @param {ReturnType<typeof readStreamConfig>} options.config an enabled configuration
 * @param {typeof BUFFER_LIMITS} [options.bufferLimits]
 * @param {number} [options.backpressureMs]
 * @param {number} [options.pollWaitMs]
 * @param {Partial<ReturnType<typeof httpLimitsFor>>} [options.httpLimits] overrides, for tests
 * @param {() => number} [options.now] the clock that spaces failure log lines
 */
function createStreamServer({
  config,
  bufferLimits = BUFFER_LIMITS,
  backpressureMs = BACKPRESSURE_MS,
  pollWaitMs = STREAM_HTTP.pollWaitMs,
  httpLimits = {},
  now = () => Date.now(),
}) {
  const limits = { ...httpLimitsFor(), ...httpLimits };
  const buffer = createFrameBuffer({ graceMs: config.graceMs, limits: bufferLimits });
  const allowedOrigins = new Set(config.allowedOrigins);
  const maxQueuedBytes = readerQueueCap(bufferLimits);
  const connections = new Set();
  const readersPerAnswer = new Map();
  let waitingToDrain = 0;
  let refusedSockets = 0;
  let failures = 0;
  let shuttingDown = null;
  /** errorKind → when it was last logged; insertion order is the order last logged. */
  const failureLoggedAt = new Map();

  /**
   * Every failure is counted (the heartbeat carries the count); each kind is logged at most once
   * per `FAILURE_LOG_INTERVAL_MS`, by kind only, so a fault that lasts shows again each hour
   * without a line per frame.
   */
  function noteFailure(error) {
    failures += 1;
    const kind = errorKind(error);
    const at = now();
    const last = failureLoggedAt.get(kind);
    if (last !== undefined && at - last < FAILURE_LOG_INTERVAL_MS) return;
    failureLoggedAt.delete(kind);
    failureLoggedAt.set(kind, at);
    while (failureLoggedAt.size > MAX_FAILURE_KINDS) {
      failureLoggedAt.delete(failureLoggedAt.keys().next().value);
    }
    console.error(`[Stream] The stream server hit an error (${kind}); answers are not affected.`);
  }

  function corsHeaders(req) {
    const headers = { Vary: "Origin" };
    const { origin } = req.headers;
    if (typeof origin === "string" && allowedOrigins.has(origin)) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Access-Control-Expose-Headers"] = "Retry-After";
    }
    return headers;
  }

  // Every answer but an admitted stream carries CLOSE: Node then destroys the socket once the
  // response is written, so a request without a valid proof never keeps a place in the socket
  // pool. A reader that is refused and retries opens a new socket.
  function refuse(req, res, refusal) {
    const body = JSON.stringify({ error: refusal.error });
    const headers = {
      ...corsHeaders(req),
      ...CLOSE,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(body),
    };
    if (refusal.retryAfterSeconds) headers["Retry-After"] = String(refusal.retryAfterSeconds);
    res.writeHead(refusal.status, headers);
    res.end(body);
  }

  function notFound(req, res) {
    res.writeHead(404, { ...corsHeaders(req), ...CLOSE, "Content-Length": 0 });
    res.end();
  }

  /**
   * Liveness for a person or the localnet harness (which asks it once at bring-up). No deployed
   * healthcheck uses it: the compose files define none and restart only on exit, so a full
   * socket pool cannot get the oracle restarted. A healthcheck added later must not use this
   * public port.
   */
  function health(res) {
    const body = JSON.stringify({ ok: true });
    res.writeHead(200, {
      ...CLOSE,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
  }

  function preflight(req, res) {
    const headers = { ...corsHeaders(req), ...CLOSE };
    if (headers["Access-Control-Allow-Origin"]) {
      headers["Access-Control-Allow-Methods"] = "GET";
      headers["Access-Control-Allow-Headers"] = PREFLIGHT_ALLOWED_HEADERS;
      headers["Access-Control-Max-Age"] = String(STREAM_HTTP.preflightMaxAgeSeconds);
    }
    res.writeHead(204, headers);
    res.end();
  }

  // --- one reader's connection ---

  function release(reader) {
    if (reader.released) return;
    reader.released = true;
    reader.ended = true;
    clearInterval(reader.heartbeat);
    clearTimeout(reader.lifetime);
    clearTimeout(reader.drainTimer);
    if (reader.drainTimer) waitingToDrain -= 1;
    reader.drainTimer = null;
    reader.unsubscribe?.();
    connections.delete(reader);
    const left = (readersPerAnswer.get(reader.id) ?? 1) - 1;
    if (left > 0) readersPerAnswer.set(reader.id, left);
    else readersPerAnswer.delete(reader.id);
  }

  function end(reader) {
    if (reader.ended) return;
    reader.ended = true;
    reader.res.end();
  }

  function destroy(reader) {
    reader.ended = true;
    reader.res.destroy();
  }

  function write(reader, chunk) {
    if (reader.ended) return;
    const accepted = reader.res.write(chunk);
    if (reader.res.writableLength > maxQueuedBytes) {
      destroy(reader);
      return;
    }
    if (accepted || reader.drainTimer) return;
    waitingToDrain += 1;
    reader.drainTimer = setTimeout(() => destroy(reader), backpressureMs);
    reader.drainTimer.unref?.();
    reader.res.once("drain", () => {
      if (!reader.drainTimer) return;
      clearTimeout(reader.drainTimer);
      reader.drainTimer = null;
      waitingToDrain -= 1;
    });
  }

  function openReader(req, res, id, mode, finished) {
    res.writeHead(200, {
      ...corsHeaders(req),
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    });
    const reader = { id, res, ended: false, released: false, drainTimer: null };
    connections.add(reader);
    readersPerAnswer.set(id, (readersPerAnswer.get(id) ?? 0) + 1);
    res.on("close", () => release(reader));

    write(reader, RETRY_LINE);
    const replay = buffer.framesAfter(id, parseSseEventId(req.headers[LAST_EVENT_ID_HEADER]));
    for (const frame of replay) write(reader, eventText(frame));
    if (finished || (mode === "poll" && replay.length > 0)) {
      end(reader);
      return;
    }

    reader.unsubscribe = buffer.subscribe(id, (event) => {
      if (event.kind === "frame") {
        write(reader, eventText(event.frame));
        if (mode === "poll") end(reader);
      } else {
        end(reader);
      }
    });
    reader.heartbeat = setInterval(() => write(reader, PING), config.heartbeatMs);
    reader.heartbeat.unref?.();
    const lifetimeMs = mode === "poll" ? Math.min(pollWaitMs, config.maxConnMs) : config.maxConnMs;
    reader.lifetime = setTimeout(() => end(reader), lifetimeMs);
    reader.lifetime.unref?.();
  }

  // --- routing ---

  function serveStream(req, res, id, query) {
    let mode = "sse";
    if (query !== "") {
      const asked = query.startsWith(MODE_QUERY_PREFIX)
        ? query.slice(MODE_QUERY_PREFIX.length)
        : null;
      if (!STREAM_HTTP.modes.includes(asked)) return refuse(req, res, STREAM_REFUSALS.badRequest);
      mode = asked;
    }
    const proof = req.headers[PROOF_HEADER];
    if (!isAnswerMessageId(id) || !isProof(proof))
      return refuse(req, res, STREAM_REFUSALS.badRequest);
    if (shuttingDown || connections.size >= config.maxConnTotal) {
      return refuse(req, res, STREAM_REFUSALS.unavailable);
    }

    const found = buffer.lookup(id);
    if (found.state === "unknown") return refuse(req, res, STREAM_REFUSALS.notOpen);
    if (found.state === "gone") return refuse(req, res, STREAM_REFUSALS.finished);
    if (found.state === "unavailable") return refuse(req, res, STREAM_REFUSALS.unavailable);
    // The proof is checked before anything about the answer's frames is written.
    if (!proofMatches(proof, found.expectedProof)) return refuse(req, res, STREAM_REFUSALS.proof);
    if ((readersPerAnswer.get(id) ?? 0) >= config.maxConnPerAnswer) {
      return refuse(req, res, STREAM_REFUSALS.busy);
    }
    return openReader(req, res, id, mode, found.state === "finished");
  }

  function route(req, res) {
    const target = typeof req.url === "string" ? req.url : "";
    // Refused before anything is parsed or read, and the connection is not kept.
    if (target.length > MAX_REQUEST_TARGET_CHARS || hasBody(req)) {
      return refuse(req, res, STREAM_REFUSALS.badRequest);
    }
    const queryAt = target.indexOf("?");
    const pathname = queryAt === -1 ? target : target.slice(0, queryAt);
    const query = queryAt === -1 ? "" : target.slice(queryAt + 1);

    if (pathname === STREAM_HTTP.healthPath && query === "" && req.method === "GET") {
      return health(res);
    }
    if (!pathname.startsWith(STREAM_HTTP.streamPathPrefix)) return notFound(req, res);
    if (req.method === "OPTIONS") return preflight(req, res);
    if (req.method !== "GET") return notFound(req, res);
    return serveStream(req, res, pathname.slice(STREAM_HTTP.streamPathPrefix.length), query);
  }

  const server = http.createServer(
    {
      maxHeaderSize: MAX_HEADER_BYTES,
      headersTimeout: limits.headersTimeoutMs,
      requestTimeout: limits.requestTimeoutMs,
      keepAliveTimeout: limits.keepAliveTimeoutMs,
      connectionsCheckingInterval: limits.connectionsCheckingIntervalMs,
    },
    (req, res) => {
      try {
        route(req, res);
      } catch (error) {
        noteFailure(error);
        if (!res.headersSent) refuse(req, res, STREAM_REFUSALS.unavailable);
        else res.destroy();
      }
    },
  );
  server.maxHeadersCount = MAX_HEADERS_COUNT;
  server.maxConnections = limits.maxConnections;
  server.maxRequestsPerSocket = limits.maxRequestsPerSocket;
  server.keepAliveTimeoutBuffer = limits.keepAliveTimeoutBufferMs;
  // A socket closed for being past maxConnections is counted; what Node passes with it is unread.
  server.on("drop", () => {
    refusedSockets += 1;
  });

  /** Guards a sink call: it must never throw into the answer path. */
  function guarded(work) {
    try {
      work();
    } catch (error) {
      noteFailure(error);
    }
  }

  return {
    // --- the sink (streamContract.js): synchronous, never throws, never waits on a reader ---
    open(id, info) {
      guarded(() => {
        if (!isAnswerMessageId(id) || !isRun(info?.run) || !isProof(info?.expectedProof)) return;
        buffer.open(id, { run: info.run, expectedProof: info.expectedProof });
      });
    },
    frame(id, info) {
      guarded(() => {
        if (!isAnswerMessageId(id) || !info) return;
        buffer.append(id, { run: info.run, seq: info.seq, ciphertext: info.ciphertext });
      });
    },
    close(id, info) {
      guarded(() => {
        if (!isAnswerMessageId(id) || !info) return;
        buffer.close(id, { run: info.run, outcome: info.outcome });
      });
    },

    // --- the server ---
    listen({ port, host } = {}) {
      return new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        server.once("error", onError);
        server.listen(port, host, () => {
          server.removeListener("error", onError);
          // From here on a server error is counted and described by kind; the answers carry on.
          server.on("error", noteFailure);
          resolve(server.address());
        });
      });
    },
    address() {
      return server.address();
    },
    /** Counts for the heartbeat's stream block; never an id, an address or a header. */
    stats() {
      const held = buffer.stats();
      return {
        connections: connections.size,
        waitingToDrain,
        refusedSockets,
        failures,
        answers: held.answers,
        bufferedBytes: held.bytes,
        refusedOpens: held.refusedOpens,
        refusedAppends: held.refusedAppends,
      };
    },
    /** Ends every reader's response, stops listening and drops the buffer. Never rejects. */
    shutdown() {
      if (shuttingDown) return shuttingDown;
      shuttingDown = new Promise((resolve) => {
        for (const reader of [...connections]) end(reader);
        buffer.dispose();
        const force = setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS);
        force.unref?.();
        server.close(() => {
          clearTimeout(force);
          resolve();
        });
        server.closeIdleConnections();
      });
      return shuttingDown;
    },
  };
}

/**
 * Starts the stream server when the settings enable it and makes it the oracle's sink. With the
 * stream switched off nothing is opened, no sink is set and no signal is listened for: the
 * oracle runs exactly as it does without a server. A port that cannot be had is logged and the
 * oracle answers without a stream, since a paid answer matters more than its live view.
 *
 * On SIGTERM the server ends every reader's response (each reconnects and is told the answer is
 * not open, or reads the stored answer) within `SHUTDOWN_GRACE_MS`, removes its handler and
 * raises the signal again. What that does depends on the process's place:
 *
 * - Outside a container, or under an init: the default action ends the process, as it would
 *   have ended without this handler.
 * - In the oracle's container, node is PID 1 (Dockerfile.oracle runs `node src/index.js`; the
 *   compose files' `sh -c 'node src/index.js'` hands its one command over to node, assuming the
 *   image's sh does so, which was not run here; if it does not, sh is PID 1 and node never sees
 *   the runtime's SIGTERM at all) and no compose file sets `init:`. The kernel gives PID 1 no
 *   default action for a signal it has no handler for, so the raised SIGTERM is ignored: the
 *   oracle goes on answering with the stream closed until the runtime sends SIGKILL. Node as
 *   PID 1 ignored SIGTERM before this handler existed too, so this is no worse; whether the
 *   oracle should exit on SIGTERM is a separate decision (it could cut an answer in flight).
 *
 * @param {object} options
 * @param {Record<string, string | undefined>} [options.env]
 * @param {(sink: object) => void} options.setSink the oracle's setStreamSink
 * @param {NodeJS.Process} [options.processRef]
 * @param {{ port?: number, host?: string }} [options.listen] where to listen; the configured
 *   port on every interface by default
 * @returns {Promise<ReturnType<typeof createStreamServer> | null>}
 */
async function startStreamFromEnv({
  env = process.env,
  setSink,
  processRef = process,
  listen,
} = {}) {
  const config = readStreamConfig(env);
  if (!config.enabled) return null;

  const server = createStreamServer({ config });
  try {
    await server.listen(listen ?? { port: config.port });
  } catch (error) {
    console.error(
      `[Stream] The live reasoning stream could not start (${errorKind(error)}); answering without it.`,
    );
    await server.shutdown();
    return null;
  }
  if (config.allowedOrigins.length === 0) {
    console.warn(
      "[Stream] No browser origin may read the live reasoning stream on this network; " +
        "set STREAM_ALLOWED_ORIGINS to allow one.",
    );
  }
  setSink(server);

  let raised = false;
  const raiseAgain = () => {
    if (raised) return;
    raised = true;
    processRef.kill(processRef.pid, "SIGTERM");
  };
  processRef.once("SIGTERM", () => {
    const deadline = setTimeout(raiseAgain, SHUTDOWN_GRACE_MS);
    deadline.unref?.();
    server.shutdown().then(() => {
      clearTimeout(deadline);
      raiseAgain();
    });
  });

  const { port } = server.address();
  console.log(`[Stream] Serving live reasoning on port ${port}.`);
  return server;
}

module.exports = {
  createStreamServer,
  startStreamFromEnv,
  httpLimitsFor,
  readerQueueCap,
  BACKPRESSURE_MS,
};
