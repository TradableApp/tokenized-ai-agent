'use strict';
// Tests for the probe client's arithmetic and its measurements against a local server.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createProbeServer } = require('../probeServer.js');
const {
  estimateSkew,
  analyseTiming,
  SseParser,
  measureSkew,
  measureTiming,
  measureBig,
  measureDown,
  streamProbe,
} = require('../probeClient.js');

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: 'http://127.0.0.1:' + server.address().port,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

test('estimateSkew keeps the sample with the shortest round trip and halves it for the error', () => {
  const result = estimateSkew([
    { t0: 1000, t1: 1100, server: 1550 },
    { t0: 2000, t1: 2010, server: 2505 },
    { t0: 3000, t1: 3040, server: 3600 },
  ]);
  assert.equal(result.offsetMs, 500);
  assert.equal(result.rttMs, 10);
  assert.equal(result.errorMs, 5);
  assert.equal(result.samples, 3);
});

test('estimateSkew refuses to guess with no samples', () => {
  assert.throws(() => estimateSkew([]), /no samples/);
});

test('analyseTiming subtracts the clock offset from each delay', () => {
  // The server clock runs 500 ms ahead; every frame really takes 20 ms.
  const frames = [0, 1, 2, 3].map((i) => ({
    seq: i + 1,
    sentAt: 10000 + i * 1000,
    arrivedAt: 10000 + i * 1000 - 500 + 20,
  }));
  const r = analyseTiming(frames, { everyMs: 1000, offsetMs: 500 });
  assert.equal(r.count, 4);
  assert.equal(r.meanDelayMs, 20);
  assert.equal(r.maxDelayMs, 20);
  assert.equal(r.bursty, false);
  assert.equal(r.bursts, 0);
});

test('analyseTiming finds frames that arrive together as a burst', () => {
  const frames = [
    { seq: 1, sentAt: 0, arrivedAt: 10 },
    { seq: 2, sentAt: 1000, arrivedAt: 3005 },
    { seq: 3, sentAt: 2000, arrivedAt: 3006 },
    { seq: 4, sentAt: 3000, arrivedAt: 3007 },
    { seq: 5, sentAt: 4000, arrivedAt: 4010 },
  ];
  const r = analyseTiming(frames, { everyMs: 1000, offsetMs: 0 });
  assert.equal(r.bursty, true);
  assert.equal(r.bursts, 1);
  assert.equal(r.largestBurst, 3);
  assert.equal(r.maxDelayMs, 2005);
});

test('SseParser joins events split across chunks and counts comments', () => {
  const p = new SseParser();
  assert.deepEqual(p.feed('id: 1\nevent: ti'), []);
  const out = p.feed('ck\ndata: {"seq":1}\n\n: ping 5\n\nevent: end\r\ndata: {}\r\n\r\n');
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], { event: 'tick', id: '1', data: '{"seq":1}' });
  assert.deepEqual(out[1], { comment: 'ping 5' });
  assert.deepEqual(out[2], { event: 'end', data: '{}' });
});

test('measureSkew against a local server finds almost no offset', async (t) => {
  const s = await listen(createProbeServer({ log: () => {} }));
  t.after(s.close);
  const skew = await measureSkew(s.base, 5);
  assert.ok(Math.abs(skew.offsetMs) < 50, 'offset ' + skew.offsetMs);
  assert.equal(skew.samples, 5);
});

test('measureTiming against a local server sees frames on time and no bursts', async (t) => {
  const s = await listen(createProbeServer({ log: () => {} }));
  t.after(s.close);
  const r = await measureTiming(s.base, { everyMs: 100, forMs: 1000, accel: 0, offsetMs: 0 });
  assert.equal(r.status, 200);
  assert.equal(r.ended, 'end-event');
  assert.ok(r.count >= 8, 'count ' + r.count);
  assert.equal(r.bursty, false);
  assert.ok(r.meanDelayMs < 50, 'mean ' + r.meanDelayMs);
});

test('measureTiming reports bursts when something holds the frames back', async (t) => {
  // Stands in for a buffering proxy: writes five frames spaced 100 ms apart by their
  // send time, but only all at once at the end.
  const buffering = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frames = [];
    let seq = 0;
    const timer = setInterval(() => {
      seq += 1;
      frames.push('id: ' + seq + '\nevent: tick\ndata: ' + JSON.stringify({ seq, sentAt: Date.now() }) + '\n\n');
      if (seq === 5) {
        clearInterval(timer);
        res.end(frames.join('') + 'event: end\ndata: {"reason":"for"}\n\n');
      }
    }, 100);
  });
  const s = await listen(buffering);
  t.after(s.close);
  const r = await measureTiming(s.base, { everyMs: 100, forMs: 1000, accel: 0, offsetMs: 0 });
  assert.equal(r.count, 5);
  assert.equal(r.bursty, true);
  assert.equal(r.largestBurst, 5);
  assert.ok(r.maxDelayMs >= 300, 'max ' + r.maxDelayMs);
});

test('measureBig confirms a 64 KiB frame arrives whole', async (t) => {
  const s = await listen(createProbeServer({ log: () => {} }));
  t.after(s.close);
  const r = await measureBig(s.base, { bytes: 65536 });
  assert.equal(r.ok, true);
  assert.equal(r.padLen, 65536);
});

test('streamProbe stops at maxMs and says it timed out', async (t) => {
  const s = await listen(createProbeServer({ log: () => {} }));
  t.after(s.close);
  const r = await streamProbe(s.base + '/probe?every=100', { maxMs: 500 });
  assert.equal(r.ended, 'timeout');
  assert.ok(r.frames.length >= 3);
});

test('measureDown reports a refused connection by error name, with no status', async () => {
  const s = await listen(http.createServer());
  const base = s.base;
  await s.close();
  const r = await measureDown(base);
  assert.equal(r.status, null);
  assert.ok(r.error && r.error.length > 0);
});
