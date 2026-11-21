'use strict';
// SSE probe server: a throwaway program for measuring how the ROFL proxy treats a
// long-lived HTTP event stream. Node built-ins only, one file.
//
// This file is also pasted, unchanged, into rofl/compose.yaml as the container's
// `node -e` program (see buildCompose.js). So it must never contain the dollar sign:
// compose would read it as a variable. A test checks this.
//
// Routes:
//   GET /health   200 {"ok":true}; the server's clock is in the X-Probe-Time header.
//   GET /probe    text/event-stream; see BOUNDS for the query parameters.
//   GET /headers  the request's header names, and only whether the forwarding headers
//                 are present (never a value), plus the request's HTTP version.
//   OPTIONS *     CORS preflight, answered only for the allowed origins.
//
// Settings from the environment: PROBE_PORT (default 8787), PROBE_HOST (default 0.0.0.0,
// as the container needs; 127.0.0.1 for a local run) and PROBE_ALLOWED_ORIGINS (comma
// list of exact origins). Logs never carry an address or a header value.
const http = require('node:http');

const DEFAULTS = {
  port: 8787,
  maxConnections: 250,
  maxLifetimeMs: 15 * 60 * 1000,
};

// Every /probe parameter, in milliseconds or bytes. A value of 0 is allowed only where
// zero is true (it means "off"). Anything else outside min..max is refused with 400.
const BOUNDS = {
  every: { min: 100, max: 900000, def: 3000, zero: false },
  heartbeat: { min: 1000, max: 300000, def: 0, zero: true },
  bytes: { min: 1, max: 262144, def: 0, zero: true },
  accel: { min: 0, max: 1, def: 0, zero: true },
  for: { min: 1000, max: 900000, def: 0, zero: true },
};

const FORWARDING_HEADERS = ['x-forwarded-for', 'x-forwarded-proto', 'via', 'forwarded'];
const PAD_PATTERN = '0123456789abcdef';

// The padding of a big frame: a repeating pattern, so a cut or a reorder is visible.
function makePad(n) {
  return PAD_PATTERN.repeat(Math.ceil(n / PAD_PATTERN.length)).slice(0, n);
}

function parseProbeParams(searchParams) {
  const params = {};
  for (const name of Object.keys(BOUNDS)) {
    const bound = BOUNDS[name];
    const raw = searchParams.get(name);
    if (raw === null) {
      params[name] = bound.def;
      continue;
    }
    const value = Number.parseInt(raw, 10);
    const canonical = String(value) === raw;
    const inRange = value >= bound.min && value <= bound.max;
    const offAllowed = bound.zero && value === 0;
    if (!canonical || !(inRange || offAllowed)) {
      return { ok: false, param: name, min: bound.min, max: bound.max, zeroAllowed: bound.zero };
    }
    params[name] = value;
  }
  return { ok: true, params };
}

function corsHeaders(req, allowedOrigins) {
  const headers = { Vary: 'Origin' };
  const origin = req.headers.origin;
  if (typeof origin === 'string' && allowedOrigins.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Expose-Headers'] = 'X-Probe-Time';
  }
  return headers;
}

function sendJson(res, status, body, extra) {
  res.writeHead(status, {
    ...extra,
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Probe-Time': String(Date.now()),
  });
  res.end(JSON.stringify(body));
}

function createProbeServer(options = {}) {
  const allowedOrigins = options.allowedOrigins || [];
  const maxConnections = options.maxConnections || DEFAULTS.maxConnections;
  const maxLifetimeMs = options.maxLifetimeMs || DEFAULTS.maxLifetimeMs;
  const log = options.log || ((line) => console.log(line));
  let active = 0;
  let nextId = 0;

  function preflight(req, res) {
    const headers = corsHeaders(req, allowedOrigins);
    if (headers['Access-Control-Allow-Origin']) {
      headers['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
      headers['Access-Control-Allow-Headers'] = 'Last-Event-ID, Cache-Control, Content-Type';
      headers['Access-Control-Max-Age'] = '600';
    }
    res.writeHead(204, headers);
    res.end();
  }

  function headerReport(req, res, cors) {
    const present = {};
    for (const name of FORWARDING_HEADERS) present[name] = req.headers[name] !== undefined;
    sendJson(
      res,
      200,
      { names: Object.keys(req.headers).sort(), present, httpVersion: req.httpVersion },
      cors,
    );
  }

  function stream(req, res, cors, params) {
    if (active >= maxConnections) {
      sendJson(res, 503, { error: 'busy', max: maxConnections }, { ...cors, 'Retry-After': '5' });
      return;
    }
    active += 1;
    nextId += 1;
    const conn = nextId;
    const opened = Date.now();
    let frames = 0;
    let closed = false;
    const timers = [];

    const headers = {
      ...cors,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Probe-Time': String(opened),
    };
    if (params.accel === 1) headers['X-Accel-Buffering'] = 'no';
    req.socket.setNoDelay(true);
    req.socket.setTimeout(0);
    res.writeHead(200, headers);

    log(
      JSON.stringify({
        ev: 'open',
        conn,
        active,
        every: params.every,
        heartbeat: params.heartbeat,
        bytes: params.bytes,
        accel: params.accel,
        for: params.for,
      }),
    );

    function cleanup(reason) {
      if (closed) return;
      closed = true;
      active -= 1;
      for (const t of timers) clearTimeout(t);
      log(
        JSON.stringify({
          ev: 'close',
          conn,
          reason,
          durationMs: Date.now() - opened,
          frames,
          active,
        }),
      );
    }

    function sendFrame() {
      frames += 1;
      const payload = { seq: frames, sentAt: Date.now() };
      if (frames === 1 && params.bytes > 0) payload.pad = makePad(params.bytes);
      res.write('id: ' + frames + '\nevent: tick\ndata: ' + JSON.stringify(payload) + '\n\n');
    }

    function finish(reason) {
      if (closed) return;
      const payload = { seq: frames, sentAt: Date.now(), reason };
      res.end('event: end\ndata: ' + JSON.stringify(payload) + '\n\n');
      cleanup(reason);
    }

    res.on('close', () => cleanup('client'));
    sendFrame();
    timers.push(setInterval(sendFrame, params.every));
    if (params.heartbeat > 0) {
      timers.push(setInterval(() => res.write(': ping ' + Date.now() + '\n\n'), params.heartbeat));
    }
    const askedFor = params.for > 0 ? params.for : Infinity;
    const endIn = Math.min(askedFor, maxLifetimeMs);
    timers.push(setTimeout(() => finish(endIn === askedFor ? 'for' : 'lifetime'), endIn));
  }

  function handle(req, res) {
    const url = new URL(req.url, 'http://probe.invalid');
    const cors = corsHeaders(req, allowedOrigins);
    if (req.method === 'OPTIONS') return preflight(req, res);
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method' }, cors);
    if (url.pathname === '/health') return sendJson(res, 200, { ok: true }, cors);
    if (url.pathname === '/headers') return headerReport(req, res, cors);
    if (url.pathname === '/probe') {
      const parsed = parseProbeParams(url.searchParams);
      if (!parsed.ok) return sendJson(res, 400, { error: 'bad-param', ...parsed }, cors);
      return stream(req, res, cors, parsed.params);
    }
    return sendJson(res, 404, { error: 'not-found' }, cors);
  }

  const server = http.createServer(handle);
  server.probeActive = () => active;
  return server;
}

function start() {
  const port = Number.parseInt(process.env.PROBE_PORT || '', 10) || DEFAULTS.port;
  const allowedOrigins = (process.env.PROBE_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const host = process.env.PROBE_HOST || '0.0.0.0';
  const server = createProbeServer({ allowedOrigins });
  server.listen(port, host, () => {
    console.log(JSON.stringify({ ev: 'listening', port, allowedOrigins: allowedOrigins.length }));
  });
  process.on('SIGTERM', () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

module.exports = { createProbeServer, parseProbeParams, makePad, BOUNDS, DEFAULTS };

// Run when started as a file or as the `node -e` program inside the container.
if (require.main === module || module.id === '[eval]') start();
