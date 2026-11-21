'use strict';
// Tests for the throwaway SSE probe server. Node built-ins only:
//   node --test 'oracle/scripts/sse-spike/test/*.test.js'
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createProbeServer, makePad } = require('../probeServer.js');

const ALLOWED = 'https://allowed.example';

async function startServer(options = {}) {
  const lines = [];
  const server = createProbeServer({
    allowedOrigins: [ALLOWED],
    log: (line) => lines.push(line),
    ...options,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  return {
    base,
    lines,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

// Reads a whole event stream into parsed blocks. Returns when the server ends it.
async function readStream(url, init = {}) {
  const res = await fetch(url, init);
  const text = await res.text();
  const blocks = text
    .split('\n\n')
    .filter((b) => b.length > 0)
    .map((block) => {
      const out = { comment: null, event: null, id: null, data: null };
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) out.comment = line.slice(1).trim();
        else if (line.startsWith('event: ')) out.event = line.slice(7);
        else if (line.startsWith('id: ')) out.id = line.slice(4);
        else if (line.startsWith('data: ')) out.data = JSON.parse(line.slice(6));
      }
      return out;
    });
  return { res, blocks };
}

test('GET /health answers {"ok":true} and the server time in a header', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const res = await fetch(s.base + '/health');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  const serverTime = Number(res.headers.get('x-probe-time'));
  assert.ok(Math.abs(serverTime - Date.now()) < 5000);
});

test('an unknown path is 404 and a POST is 405', async (t) => {
  const s = await startServer();
  t.after(s.close);
  assert.equal((await fetch(s.base + '/nope')).status, 404);
  assert.equal((await fetch(s.base + '/health', { method: 'POST' })).status, 405);
});

test('/probe refuses every parameter outside its bounds with 400 and names it', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const cases = [
    ['every=50', 'every'],
    ['every=abc', 'every'],
    ['every=0', 'every'],
    ['every=900001', 'every'],
    ['every=03000', 'every'],
    ['heartbeat=500', 'heartbeat'],
    ['heartbeat=300001', 'heartbeat'],
    ['bytes=262145', 'bytes'],
    ['bytes=-1', 'bytes'],
    ['accel=2', 'accel'],
    ['for=999', 'for'],
    ['for=900001', 'for'],
  ];
  for (const [query, param] of cases) {
    const res = await fetch(s.base + '/probe?' + query);
    assert.equal(res.status, 400, query);
    const body = await res.json();
    assert.equal(body.param, param, query);
  }
});

test('/probe streams numbered frames carrying the send time and ends after for=', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const before = Date.now();
  const { res, blocks } = await readStream(s.base + '/probe?every=100&for=1000');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/event-stream/);
  assert.match(res.headers.get('cache-control'), /no-cache/);
  assert.equal(res.headers.get('x-accel-buffering'), null);
  assert.equal(res.headers.get('content-encoding'), null);
  const ticks = blocks.filter((b) => b.event === 'tick');
  assert.ok(ticks.length >= 8 && ticks.length <= 12, 'frames: ' + ticks.length);
  ticks.forEach((b, i) => {
    assert.equal(b.data.seq, i + 1);
    assert.equal(b.id, String(i + 1));
    assert.ok(b.data.sentAt >= before && b.data.sentAt <= Date.now());
  });
  const end = blocks.at(-1);
  assert.equal(end.event, 'end');
  assert.equal(end.data.reason, 'for');
  assert.equal(end.data.seq, ticks.length);
});

test('/probe sends X-Accel-Buffering: no only when accel=1', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const { res } = await readStream(s.base + '/probe?every=100&for=1000&accel=1');
  assert.equal(res.headers.get('x-accel-buffering'), 'no');
});

test('/probe sends ": ping" comments at the heartbeat interval', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const { blocks } = await readStream(s.base + '/probe?every=900000&heartbeat=1000&for=2500');
  const pings = blocks.filter((b) => b.comment !== null && b.comment.startsWith('ping'));
  assert.equal(pings.length, 2);
  // Only the first frame is sent: the next would be due in 15 minutes.
  assert.equal(blocks.filter((b) => b.event === 'tick').length, 1);
});

test('/probe pads the first frame to bytes= with a checkable pattern', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const { blocks } = await readStream(s.base + '/probe?every=500&bytes=65536&for=1200');
  const ticks = blocks.filter((b) => b.event === 'tick');
  assert.equal(ticks[0].data.pad.length, 65536);
  assert.equal(ticks[0].data.pad, makePad(65536));
  assert.equal(ticks[1].data.pad, undefined);
});

test('CORS: an allowed origin is echoed with Vary: Origin; another origin gets no grant', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const ok = await fetch(s.base + '/health', { headers: { origin: ALLOWED } });
  assert.equal(ok.headers.get('access-control-allow-origin'), ALLOWED);
  assert.match(ok.headers.get('vary'), /Origin/);
  assert.match(ok.headers.get('access-control-expose-headers'), /X-Probe-Time/i);

  const other = await fetch(s.base + '/health', { headers: { origin: 'https://evil.example' } });
  assert.equal(other.status, 200);
  assert.equal(other.headers.get('access-control-allow-origin'), null);
  assert.match(other.headers.get('vary'), /Origin/);

  const none = await fetch(s.base + '/health');
  assert.equal(none.headers.get('access-control-allow-origin'), null);
});

test('CORS: a preflight from an allowed origin is answered; from another it grants nothing', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const preflight = (origin) =>
    fetch(s.base + '/probe', {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'last-event-id',
      },
    });
  const ok = await preflight(ALLOWED);
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('access-control-allow-origin'), ALLOWED);
  assert.match(ok.headers.get('access-control-allow-methods'), /GET/);
  assert.match(ok.headers.get('access-control-allow-headers'), /Last-Event-ID/i);
  assert.match(ok.headers.get('vary'), /Origin/);

  const denied = await preflight('https://evil.example');
  assert.equal(denied.status, 204);
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
  assert.equal(denied.headers.get('access-control-allow-methods'), null);
});

test('/headers lists header names and only the presence of forwarding headers, never a value', async (t) => {
  const s = await startServer();
  t.after(s.close);
  const res = await fetch(s.base + '/headers', {
    headers: { 'x-forwarded-for': '203.0.113.7', via: '1.1 secret-proxy-name', 'x-custom-thing': 'v4lue' },
  });
  const text = await res.text();
  assert.ok(!text.includes('203.0.113.7'));
  assert.ok(!text.includes('secret-proxy-name'));
  assert.ok(!text.includes('v4lue'));
  const body = JSON.parse(text);
  assert.ok(body.names.includes('x-forwarded-for'));
  assert.ok(body.names.includes('x-custom-thing'));
  assert.deepEqual(body.present, {
    'x-forwarded-for': true,
    'x-forwarded-proto': false,
    via: true,
    forwarded: false,
  });
  assert.equal(body.httpVersion, '1.1');
});

test('the stream cap refuses one connection too many with 503 and frees the slot on close', async (t) => {
  const s = await startServer({ maxConnections: 2 });
  t.after(s.close);
  const controllers = [new AbortController(), new AbortController()];
  const open = await Promise.all(
    controllers.map((c) => fetch(s.base + '/probe?every=100000', { signal: c.signal })),
  );
  open.forEach((r) => assert.equal(r.status, 200));
  const third = await fetch(s.base + '/probe?every=100000');
  assert.equal(third.status, 503);
  assert.equal((await third.json()).error, 'busy');
  assert.ok(third.headers.get('retry-after'));

  controllers[0].abort();
  await new Promise((r) => setTimeout(r, 200));
  const again = new AbortController();
  const fourth = await fetch(s.base + '/probe?every=100000', { signal: again.signal });
  assert.equal(fourth.status, 200);
  again.abort();
  controllers[1].abort();
});

test('a stream is ended at the lifetime cap, and for= longer than the cap is cut to it', async (t) => {
  const s = await startServer({ maxLifetimeMs: 1500 });
  t.after(s.close);
  const started = Date.now();
  const { blocks } = await readStream(s.base + '/probe?every=900000&for=60000');
  const took = Date.now() - started;
  assert.ok(took >= 1400 && took < 3000, 'took ' + took);
  assert.equal(blocks.at(-1).event, 'end');
  assert.equal(blocks.at(-1).data.reason, 'lifetime');
});

test('logs one line per open and close with duration and frames, never an address or header value', async (t) => {
  const s = await startServer();
  t.after(s.close);
  await readStream(s.base + '/probe?every=100&for=1000', {
    headers: { 'x-forwarded-for': '203.0.113.7', 'user-agent': 'probe-test-agent' },
  });
  await new Promise((r) => setTimeout(r, 50));
  const parsed = s.lines.map((l) => JSON.parse(l));
  const open = parsed.filter((l) => l.ev === 'open');
  const close = parsed.filter((l) => l.ev === 'close');
  assert.equal(open.length, 1);
  assert.equal(close.length, 1);
  assert.equal(close[0].reason, 'for');
  assert.ok(close[0].frames >= 8);
  assert.ok(close[0].durationMs >= 900);
  const all = s.lines.join('\n');
  for (const secret of ['127.0.0.1', '203.0.113.7', 'probe-test-agent']) {
    assert.ok(!all.includes(secret), secret);
  }
});

test('the server source has no dollar sign, so it can be pasted into compose unchanged', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'probeServer.js'), 'utf8');
  assert.equal(src.includes(String.fromCharCode(36)), false);
});
