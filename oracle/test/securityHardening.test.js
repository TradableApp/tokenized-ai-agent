'use strict';

const { expect } = require('chai');
const { scrubSensitiveData } = require('../src/sentryInit');
const { jsonReplacer } = require('../src/formatters');

/**
 * Code-level security findings from the cross-repo review, 2026-09-22 (CU-14ym9bv73e5).
 */

describe('security hardening — BigInt-safe JSON serialisation', () => {
  // The failed-jobs queue stores `event.args`, which ethers v6 populates with BigInt for every
  // uint256. JSON.stringify THROWS on a BigInt, so the write that is supposed to queue a
  // retryable job instead threw inside the error handler: the job was never queued AND the
  // cursor was never persisted. A retryable failure became a silent loss.
  it('serialises BigInt rather than throwing', () => {
    const job = { conversationId: 42n, blockNumber: 7 };

    expect(() => JSON.stringify(job)).to.throw(TypeError);
    expect(() => JSON.stringify(job, jsonReplacer)).to.not.throw();
  });

  it('round-trips a BigInt as its decimal string, preserving full precision', () => {
    // Must not go via Number — uint256 ids exceed Number.MAX_SAFE_INTEGER routinely.
    const big = 123456789012345678901234567890n;
    const out = JSON.parse(JSON.stringify({ id: big }, jsonReplacer));

    expect(out.id).to.equal('123456789012345678901234567890');
  });

  it('leaves non-BigInt values untouched', () => {
    const out = JSON.parse(
      JSON.stringify({ a: 1, b: 'x', c: null, d: [1, 2], e: { f: true } }, jsonReplacer),
    );

    expect(out).to.deep.equal({ a: 1, b: 'x', c: null, d: [1, 2], e: { f: true } });
  });
});

describe('security hardening — Sentry scrubbing', () => {
  // The matcher compares `key.toLowerCase().includes(sensitive.toLowerCase())`, so a screaming-
  // snake env var never matched its camelCase entry: "private_key".includes("privatekey") is
  // false. PRIVATE_KEY is the exact name the TEE's own secret uses (rofl.yaml), so the single
  // most sensitive value in the system was being sent to Sentry in the clear.
  it('redacts PRIVATE_KEY — the screaming-snake form the TEE actually uses', () => {
    const result = scrubSensitiveData({ PRIVATE_KEY: 'deadbeef' });

    expect(result.PRIVATE_KEY).to.equal('[REDACTED]');
  });

  it('redacts regardless of separator or case', () => {
    const result = scrubSensitiveData({
      PRIVATE_KEY: 'a',
      privateKey: 'b',
      'private-key': 'c',
      PrivateKey: 'd',
    });

    for (const k of Object.keys(result)) {
      expect(result[k], k).to.equal('[REDACTED]');
    }
  });

  it('redacts the other secrets the ROFL app is given', () => {
    const result = scrubSensitiveData({
      IRYS_PAYMENT_PRIVATE_KEY: 'a',
      POSTGRES_PASSWORD: 'b',
      POSTGRES_CLIENT_KEY: 'c',
      CHAIN_GPT_API_KEY: 'd',
      GOOGLE_GENERATIVE_AI_API_KEY: 'e',
      SLACK_ACCESS_TOKEN: 'f',
      TRADABLE_API_ACCESS_TOKEN: 'g',
      SEND_GRID_API_KEY: 'h',
    });

    for (const k of Object.keys(result)) {
      expect(result[k], k).to.equal('[REDACTED]');
    }
  });

  it('still keeps benign fields, so reports stay useful', () => {
    const result = scrubSensitiveData({
      message: 'boom',
      blockNumber: 12,
      publicKey: '0x04abc',
      monkey: 'not a secret',
    });

    expect(result.message).to.equal('boom');
    expect(result.blockNumber).to.equal(12);
    expect(result.monkey).to.equal('not a secret');
  });

  it('survives a circular reference instead of throwing out of beforeSend', () => {
    // If beforeSend throws, Sentry drops the event — so a crash here blinds ALL monitoring,
    // which is strictly worse than the bug being reported.
    const obj = { safe: 1 };
    obj.self = obj;

    expect(() => scrubSensitiveData(obj)).to.not.throw();
  });

  it('redacts nested secrets', () => {
    const result = scrubSensitiveData({ extra: { PRIVATE_KEY: 'x', ok: 'y' } });

    expect(result.extra.PRIVATE_KEY).to.equal('[REDACTED]');
    expect(result.extra.ok).to.equal('y');
  });
});
