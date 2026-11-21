'use strict';
// The probe's ROFL app: the committed compose file must carry the server source unchanged,
// pin its image by digest, publish the probe port, build nothing and hold no secrets.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderCompose } = require('../buildCompose.js');

const dir = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(dir, p), 'utf8');

test('rofl/compose.yaml is exactly what buildCompose.js renders from probeServer.js', () => {
  assert.equal(read('rofl/compose.yaml'), renderCompose(read('probeServer.js')));
});

test('the compose file carries every line of the server source, indented as a block', () => {
  const compose = read('rofl/compose.yaml');
  for (const line of read('probeServer.js').split('\n')) {
    if (line.length > 0) assert.ok(compose.includes('        ' + line), line);
  }
});

test('the image is a fully qualified public Node image pinned by digest', () => {
  const compose = read('rofl/compose.yaml');
  assert.match(compose, /image: docker\.io\/library\/node:24-alpine@sha256:[0-9a-f]{64}\n/);
});

test('the probe port is published, nothing is built and no variable is read', () => {
  const compose = read('rofl/compose.yaml');
  assert.match(compose, /- "8787:8787"/);
  assert.ok(!/^\s*build:/m.test(compose));
  assert.equal(compose.includes(String.fromCharCode(36)), false);
});

test('the manifest asks for no secrets and names no deployment yet', () => {
  const manifest = read('rofl/rofl.yaml');
  assert.ok(!/secrets:/.test(manifest));
  assert.ok(!/^deployments:/m.test(manifest));
  assert.match(manifest, /^name: sse-probe$/m);
  assert.match(manifest, /compose: compose\.yaml/);
});
