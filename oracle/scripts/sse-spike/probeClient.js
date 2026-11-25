'use strict';
// SSE probe client: runs named measurements against a probe server (probeServer.js) and
// prints one JSON line per measurement, then a short table. Node built-ins only (Node 18+).
//
//   node probeClient.js <base-url> <measure...> [--every=3000] [--hold=900000]
//                       [--conns=50,200] [--parallel]
//
// Measures: timing idle heartbeat long concurrent big headers down
// --parallel runs the named measures at the same time (use it for idle, heartbeat and
// long, which each just hold a connection open); otherwise they run one after another.

const PAD_PATTERN = '0123456789abcdef';
const MEASURES = ['timing', 'idle', 'heartbeat', 'long', 'concurrent', 'big', 'headers', 'down'];
const HEADERS_KEPT = ['content-type', 'content-encoding', 'cache-control', 'x-accel-buffering', 'via'];

function makePad(n) {
  return PAD_PATTERN.repeat(Math.ceil(n / PAD_PATTERN.length)).slice(0, n);
}

const round1 = (n) => Math.round(n * 10) / 10;

// Clock skew between this machine and the server.
//
// Each sample is one GET /health: t0 is our clock just before sending, t1 just after the
// answer arrives, and server is the server's clock (X-Probe-Time) when it answered. If the
// trip out and the trip back take equally long, the server read its clock at our
// (t0 + t1) / 2, so offset = server - (t0 + t1) / 2 (positive: the server is ahead). The
// true moment lies somewhere between t0 and t1, so the error is at most half the round
// trip. We keep the sample with the shortest round trip, as NTP does, since it has the
// smallest error. Arrival delays below are corrected by this offset.
function estimateSkew(samples) {
  if (!samples || samples.length === 0) throw new Error('estimateSkew: no samples');
  const best = samples.reduce((a, b) => (b.t1 - b.t0 < a.t1 - a.t0 ? b : a));
  const rttMs = best.t1 - best.t0;
  return {
    offsetMs: round1(best.server - (best.t0 + best.t1) / 2),
    rttMs,
    errorMs: round1(rttMs / 2),
    samples: samples.length,
  };
}

// Delay per frame is arrival time minus send time, with the send time moved onto our clock
// (sentAt - offset). A burst is two or more frames whose arrivals are closer together than
// a quarter of the send interval: frames sent `every` ms apart that arrive together were
// held back somewhere on the way.
function analyseTiming(frames, { everyMs, offsetMs }) {
  if (frames.length === 0) {
    return { count: 0, meanDelayMs: null, maxDelayMs: null, minDelayMs: null, bursts: 0, largestBurst: 0, bursty: false };
  }
  const delays = frames.map((f) => f.arrivedAt - (f.sentAt - offsetMs));
  const gapLimit = everyMs / 4;
  let bursts = 0;
  let largestBurst = 0;
  let run = 1;
  const closeRun = () => {
    if (run >= 2) {
      bursts += 1;
      largestBurst = Math.max(largestBurst, run);
    }
  };
  for (let i = 1; i < frames.length; i += 1) {
    if (frames[i].arrivedAt - frames[i - 1].arrivedAt < gapLimit) run += 1;
    else {
      closeRun();
      run = 1;
    }
  }
  closeRun();
  return {
    count: frames.length,
    meanDelayMs: round1(delays.reduce((a, b) => a + b, 0) / delays.length),
    maxDelayMs: round1(Math.max(...delays)),
    minDelayMs: round1(Math.min(...delays)),
    bursts,
    largestBurst,
    bursty: bursts > 0,
  };
}

// Incremental event-stream parser: feed text as it arrives, get whole events back.
class SseParser {
  constructor() {
    this.buf = '';
  }

  feed(text) {
    this.buf += text.replace(/\r\n/g, '\n');
    const out = [];
    let idx = this.buf.indexOf('\n\n');
    while (idx >= 0) {
      const block = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      if (block.length > 0) out.push(SseParser.parseBlock(block));
      idx = this.buf.indexOf('\n\n');
    }
    return out;
  }

  static parseBlock(block) {
    const lines = block.split('\n');
    if (lines.every((l) => l.startsWith(':'))) return { comment: lines[0].slice(1).trim() };
    const ev = {};
    const data = [];
    for (const line of lines) {
      const colon = line.indexOf(':');
      if (colon <= 0) continue;
      const field = line.slice(0, colon);
      const value = line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') ev.event = value;
      else if (field === 'id') ev.id = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length > 0) ev.data = data.join('\n');
    return ev;
  }
}

function errorName(err) {
  const cause = err && err.cause && (err.cause.code || err.cause.name);
  return [err && err.name, cause].filter(Boolean).join(':') || 'unknown';
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Opens one stream and records every frame with its arrival time. Stops at the server's
// end event, at the end of the body, on an error, or after maxMs (ended: 'timeout').
async function streamProbe(url, { maxMs = 60000, headers = {} } = {}) {
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), maxMs);
  const r = { status: null, headers: {}, openedAfterMs: null, frames: [], comments: 0, badFrames: 0, end: null, ended: null, endedAfterMs: null, lastByteGapMs: null, error: null };
  let lastByte = started;
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { accept: 'text/event-stream', ...headers } });
    r.status = res.status;
    r.openedAfterMs = Date.now() - started;
    for (const name of HEADERS_KEPT) {
      const v = res.headers.get(name);
      if (v !== null) r.headers[name] = v;
    }
    if (res.status !== 200 || !res.body) {
      await res.arrayBuffer().catch(() => null);
      r.ended = 'status';
      return r;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    for (;;) {
      const { value, done } = await reader.read();
      const now = Date.now();
      if (done) {
        r.ended = r.end ? 'end-event' : 'eof';
        break;
      }
      lastByte = now;
      for (const ev of parser.feed(decoder.decode(value, { stream: true }))) {
        if (ev.comment !== undefined) r.comments += 1;
        else if (ev.event === 'end') r.end = safeJson(ev.data);
        else if (ev.event === 'tick') {
          const d = safeJson(ev.data);
          if (!d) {
            r.badFrames += 1;
            continue;
          }
          const frame = { seq: d.seq, sentAt: d.sentAt, arrivedAt: now };
          if (typeof d.pad === 'string') {
            frame.padLen = d.pad.length;
            frame.padOk = d.pad === makePad(d.pad.length);
          }
          r.frames.push(frame);
        }
      }
    }
  } catch (err) {
    r.ended = ac.signal.aborted ? 'timeout' : 'error';
    if (!ac.signal.aborted) r.error = errorName(err);
  } finally {
    clearTimeout(timer);
    r.endedAfterMs = Date.now() - started;
    r.lastByteGapMs = Date.now() - lastByte;
  }
  return r;
}

const probeUrl = (base, q) => base + '/probe?' + new URLSearchParams(q).toString();

async function measureSkew(base, count = 8) {
  const samples = [];
  for (let i = 0; i < count; i += 1) {
    const t0 = Date.now();
    const res = await fetch(base + '/health', { cache: 'no-store' });
    await res.text();
    const t1 = Date.now();
    const server = Number(res.headers.get('x-probe-time'));
    if (!Number.isFinite(server) || server <= 0) throw new Error('no X-Probe-Time header on /health');
    samples.push({ t0, t1, server });
  }
  return estimateSkew(samples);
}

async function measureTiming(base, { everyMs = 3000, forMs = 60000, accel = 0, offsetMs = 0 }) {
  const s = await streamProbe(probeUrl(base, { every: everyMs, for: forMs, accel }), { maxMs: forMs + 30000 });
  return { accel, status: s.status, headers: s.headers, ended: s.ended, error: s.error, ...analyseTiming(s.frames, { everyMs, offsetMs }) };
}

// A stream held open: idle (no heartbeat) or with a heartbeat. Only the first frame is
// sent (every=15 min), so the connection is silent apart from heartbeats.
async function measureHold(base, { heartbeatMs, holdMs }) {
  const s = await streamProbe(probeUrl(base, { every: 900000, heartbeat: heartbeatMs, for: holdMs }), { maxMs: holdMs + 60000 });
  return {
    heartbeatMs,
    status: s.status,
    ended: s.ended,
    endReason: s.end ? s.end.reason : null,
    heldMs: s.endedAfterMs,
    silenceBeforeEndMs: s.lastByteGapMs,
    pings: s.comments,
    error: s.error,
  };
}

async function measureLong(base) {
  const forMs = 600000;
  const s = await streamProbe(probeUrl(base, { every: 30000, heartbeat: 15000, for: forMs }), { maxMs: forMs + 60000 });
  return { status: s.status, ended: s.ended, endReason: s.end ? s.end.reason : null, heldMs: s.endedAfterMs, frames: s.frames.length, expectedFrames: 20, pings: s.comments, error: s.error };
}

async function measureConcurrent(base, n) {
  const everyMs = 2000;
  const forMs = 30000;
  const expected = forMs / everyMs;
  const runs = await Promise.all(
    Array.from({ length: n }, () => streamProbe(probeUrl(base, { every: everyMs, for: forMs }), { maxMs: forMs + 30000 })),
  );
  const statuses = {};
  const errors = {};
  for (const r of runs) {
    const key = String(r.status);
    statuses[key] = (statuses[key] || 0) + 1;
    if (r.error) errors[r.error] = (errors[r.error] || 0) + 1;
  }
  const opened = runs.filter((r) => r.status === 200);
  return {
    connections: n,
    opened: opened.length,
    complete: runs.filter((r) => r.ended === 'end-event' && r.frames.length >= expected - 1).length,
    statuses,
    errors,
    maxOpenMs: opened.length ? Math.max(...opened.map((r) => r.openedAfterMs)) : null,
  };
}

async function measureBig(base, { bytes = 65536 } = {}) {
  const s = await streamProbe(probeUrl(base, { every: 1000, bytes, for: 3000 }), { maxMs: 30000 });
  const first = s.frames[0];
  return {
    status: s.status,
    ended: s.ended,
    padLen: first ? first.padLen || 0 : 0,
    ok: Boolean(first && first.padLen === bytes && first.padOk && s.badFrames === 0),
    badFrames: s.badFrames,
    error: s.error,
  };
}

async function measureHeaders(base) {
  const res = await fetch(base + '/headers', { cache: 'no-store' });
  return { status: res.status, ...(await res.json()) };
}

// What arrives when nothing answers behind the proxy. Reports the status, content type and
// body length only: the body is the proxy's own page.
async function measureDown(base) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20000);
  try {
    const res = await fetch(base + '/health', { signal: ac.signal, cache: 'no-store' });
    const body = await res.arrayBuffer();
    return { status: res.status, contentType: res.headers.get('content-type'), bodyBytes: body.byteLength, error: null };
  } catch (err) {
    return { status: null, contentType: null, bodyBytes: 0, error: ac.signal.aborted ? 'timeout' : errorName(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function runMeasure(name, base, opts) {
  switch (name) {
    case 'timing':
      return {
        runs: await Promise.all([0, 1].map((accel) => measureTiming(base, { everyMs: opts.everyMs, forMs: 60000, accel, offsetMs: opts.offsetMs }))),
      };
    case 'idle':
      return measureHold(base, { heartbeatMs: 0, holdMs: opts.holdMs });
    case 'heartbeat':
      return { runs: await Promise.all([15000, 60000].map((heartbeatMs) => measureHold(base, { heartbeatMs, holdMs: opts.holdMs }))) };
    case 'long':
      return measureLong(base);
    case 'concurrent': {
      const runs = [];
      for (const n of opts.conns) runs.push(await measureConcurrent(base, n));
      return { runs };
    }
    case 'big':
      return measureBig(base);
    case 'headers':
      return measureHeaders(base);
    case 'down':
      return measureDown(base);
    default:
      throw new Error('unknown measure ' + name);
  }
}

function summarise(name, r) {
  if (r.error && !r.runs) return 'error: ' + r.error;
  const hold = (h) =>
    h.endReason ? 'held ' + Math.round(h.heldMs / 1000) + ' s to the server end (' + h.endReason + ')' : 'cut after ' + Math.round(h.heldMs / 1000) + ' s, ' + Math.round(h.silenceBeforeEndMs / 1000) + ' s after the last byte (' + h.ended + (h.error ? ' ' + h.error : '') + ')';
  switch (name) {
    case 'timing':
      return r.runs.map((t) => 'accel=' + t.accel + ': ' + t.count + ' frames, mean ' + t.meanDelayMs + ' ms, max ' + t.maxDelayMs + ' ms, bursty ' + (t.bursty ? 'YES' : 'no') + ', encoding ' + (t.headers['content-encoding'] || 'none')).join(' | ');
    case 'idle':
      return hold(r);
    case 'heartbeat':
      return r.runs.map((h) => h.heartbeatMs / 1000 + ' s: ' + hold(h)).join(' | ');
    case 'long':
      return (r.endReason === 'for' ? 'held 10 min' : 'NOT held: ' + r.ended) + ', ' + r.frames + '/' + r.expectedFrames + ' frames';
    case 'concurrent':
      return r.runs.map((c) => c.connections + ': ' + c.opened + ' opened, ' + c.complete + ' complete, statuses ' + JSON.stringify(c.statuses)).join(' | ');
    case 'big':
      return r.ok ? '64 KiB frame intact' : 'NOT intact: ' + r.padLen + ' bytes of pad, ' + r.badFrames + ' unreadable';
    case 'headers':
      return 'HTTP ' + r.httpVersion + ' to the app; ' + Object.entries(r.present).map(([k, v]) => k + ' ' + (v ? 'present' : 'absent')).join(', ');
    case 'down':
      return r.status === null ? 'no answer: ' + r.error : 'status ' + r.status + ', ' + r.contentType + ', ' + r.bodyBytes + ' bytes';
    default:
      return '';
  }
}

function parseArgs(argv) {
  const opts = { everyMs: 3000, holdMs: 900000, conns: [50, 200], parallel: false };
  const positional = [];
  for (const a of argv) {
    if (a === '--parallel') opts.parallel = true;
    else if (a.startsWith('--every=')) opts.everyMs = Number(a.slice(8));
    else if (a.startsWith('--hold=')) opts.holdMs = Number(a.slice(7));
    else if (a.startsWith('--conns=')) opts.conns = a.slice(8).split(',').map(Number);
    else positional.push(a);
  }
  const [rawBase, ...measures] = positional;
  const base = new URL(rawBase || 'invalid:').href.replace(/\/+$/, '');
  if (!/^https?:/.test(base)) throw new Error('first argument must be the probe base URL (http or https)');
  for (const m of measures) if (!MEASURES.includes(m)) throw new Error('unknown measure ' + m + '; known: ' + MEASURES.join(' '));
  if (measures.length === 0) throw new Error('name at least one measure: ' + MEASURES.join(' '));
  if (!(opts.holdMs >= 1000 && opts.holdMs <= 900000)) throw new Error('--hold must be 1000..900000 ms');
  return { base, measures, opts };
}

async function main() {
  const { base, measures, opts } = parseArgs(process.argv.slice(2));
  const rows = [];
  const print = (name, result) => {
    console.log(JSON.stringify({ measure: name, at: new Date().toISOString(), ...result }));
    rows.push([name, summarise(name, result)]);
  };
  opts.offsetMs = 0;
  if (!(measures.length === 1 && measures[0] === 'down')) {
    const skew = await measureSkew(base);
    opts.offsetMs = skew.offsetMs;
    print('skew', skew);
    rows[rows.length - 1][1] = 'server ' + skew.offsetMs + ' ms ahead, error +/- ' + skew.errorMs + ' ms';
  }
  const run = async (name) => {
    try {
      print(name, await runMeasure(name, base, opts));
    } catch (err) {
      print(name, { error: errorName(err) + ': ' + String(err.message).split('\n')[0] });
    }
  };
  if (opts.parallel) await Promise.all(measures.map(run));
  else for (const m of measures) await run(m);
  console.log('');
  for (const [name, text] of rows) console.log(name.padEnd(11) + ' ' + text);
}

module.exports = {
  estimateSkew,
  analyseTiming,
  SseParser,
  streamProbe,
  measureSkew,
  measureTiming,
  measureHold,
  measureLong,
  measureConcurrent,
  measureBig,
  measureHeaders,
  measureDown,
  summarise,
  parseArgs,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
