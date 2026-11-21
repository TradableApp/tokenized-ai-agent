const http = require("node:http");
const crypto = require("node:crypto");

const {
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
const { readStreamConfig } = require("./streamConfig");
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
 * that falls more than two answers' worth of bytes behind is destroyed at once, so a slow or
 * hostile reader costs bounded memory and never time on the answer path.
 *
 * WHY IT LOGS SO LITTLE. This is a network surface inside the TEE and the machine's logs are
 * kept. No request is logged; nothing a reader sent (its address, its headers, the answer id it
 * asked for) appears in a log line or an error (oracle/test/streamLogging.test.js). Failures are
 * described by kind only (`errorKind`).
 *
 * WHAT IT DOES NOT DO (by plan): TLS (the ROFL proxy's job, measured in Phase 0), per-address
 * rate limits (no address the proxy vouches for is known yet), and a relay for when the proxy
 * cannot carry a stream.
 */

/** A reader whose socket has not drained this long after a refused write is destroyed. */
const BACKPRESSURE_MS = 10000;
/** `/stream/` + a 78-digit id + `?mode=poll` is under 100; anything longer is not a request we serve. */
const MAX_REQUEST_TARGET_CHARS = 128;
/** Request line and headers together; a browser's GET with these headers is far below it. */
const MAX_HEADER_BYTES = 8192;
const MAX_HEADERS_COUNT = 50;
const HEADERS_TIMEOUT_MS = 10000;
const REQUEST_TIMEOUT_MS = 15000;
/** How long shutdown waits for responses to finish before closing every socket. */
const SHUTDOWN_GRACE_MS = 2000;

const PROOF_HEADER = STREAM_HTTP.proofHeader.toLowerCase();
const LAST_EVENT_ID_HEADER = STREAM_HTTP.lastEventIdHeader.toLowerCase();
const PREFLIGHT_ALLOWED_HEADERS = `${STREAM_HTTP.proofHeader}, ${STREAM_HTTP.lastEventIdHeader}`;
const MODE_QUERY_PREFIX = "mode=";
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

/**
 * @param {object} options
 * @param {ReturnType<typeof readStreamConfig>} options.config an enabled configuration
 * @param {typeof BUFFER_LIMITS} [options.bufferLimits]
 * @param {number} [options.backpressureMs]
 * @param {number} [options.pollWaitMs]
 */
function createStreamServer({
  config,
  bufferLimits = BUFFER_LIMITS,
  backpressureMs = BACKPRESSURE_MS,
  pollWaitMs = STREAM_HTTP.pollWaitMs,
}) {
  const buffer = createFrameBuffer({ graceMs: config.graceMs, limits: bufferLimits });
  const allowedOrigins = new Set(config.allowedOrigins);
  const maxQueuedBytes = 2 * bufferLimits.maxAnswerBytes;
  const connections = new Set();
  const readersPerAnswer = new Map();
  let waitingToDrain = 0;
  let shuttingDown = null;
  let failureLogged = false;

  function noteFailure(error) {
    if (failureLogged) return;
    failureLogged = true;
    console.error(
      `[Stream] The stream server hit an error (${errorKind(error)}); answers are not affected.`,
    );
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

  function refuse(req, res, refusal, { closeConnection = false } = {}) {
    const body = JSON.stringify({ error: refusal.error });
    const headers = {
      ...corsHeaders(req),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(body),
    };
    if (refusal.retryAfterSeconds) headers["Retry-After"] = String(refusal.retryAfterSeconds);
    if (closeConnection) headers.Connection = "close";
    res.writeHead(refusal.status, headers);
    res.end(body);
  }

  function notFound(req, res) {
    res.writeHead(404, { ...corsHeaders(req), "Content-Length": 0 });
    res.end();
  }

  function preflight(req, res) {
    const headers = corsHeaders(req);
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

    write(reader, `retry: ${STREAM_HTTP.sseRetryMs}\n\n`);
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
      return refuse(req, res, STREAM_REFUSALS.badRequest, { closeConnection: true });
    }
    const queryAt = target.indexOf("?");
    const pathname = queryAt === -1 ? target : target.slice(0, queryAt);
    const query = queryAt === -1 ? "" : target.slice(queryAt + 1);

    if (pathname === STREAM_HTTP.healthPath && query === "" && req.method === "GET") {
      const body = JSON.stringify({ ok: true });
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      });
      return res.end(body);
    }
    if (!pathname.startsWith(STREAM_HTTP.streamPathPrefix)) return notFound(req, res);
    if (req.method === "OPTIONS") return preflight(req, res);
    if (req.method !== "GET") return notFound(req, res);
    return serveStream(req, res, pathname.slice(STREAM_HTTP.streamPathPrefix.length), query);
  }

  const server = http.createServer(
    {
      maxHeaderSize: MAX_HEADER_BYTES,
      headersTimeout: HEADERS_TIMEOUT_MS,
      requestTimeout: REQUEST_TIMEOUT_MS,
    },
    (req, res) => {
      try {
        route(req, res);
      } catch (error) {
        noteFailure(error);
        if (!res.headersSent)
          refuse(req, res, STREAM_REFUSALS.unavailable, { closeConnection: true });
        else res.destroy();
      }
    },
  );
  server.maxHeadersCount = MAX_HEADERS_COUNT;

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
          // From here on a server error is described once and the answers carry on.
          server.on("error", noteFailure);
          resolve(server.address());
        });
      });
    },
    address() {
      return server.address();
    },
    stats() {
      return { connections: connections.size, waitingToDrain };
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
 * not open, or reads the stored answer) within `SHUTDOWN_GRACE_MS`, then the signal is raised
 * again so the process ends exactly as it would have without this handler.
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

module.exports = { createStreamServer, startStreamFromEnv, BACKPRESSURE_MS };
