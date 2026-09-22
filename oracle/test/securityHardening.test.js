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

describe('security hardening — bad-input classification', () => {
  // isBadInputError decides whether an event is DROPPED PERMANENTLY: no retry, no alert, cursor
  // advanced past it. Classifying by error MESSAGE means any unrelated failure whose text happens
  // to contain one of those substrings is discarded forever and silently.
  //
  // "Unexpected token" is the dangerous one. JSON.parse throws it anywhere — including on a
  // gateway or RPC that answers with an HTML error page during an outage. That is a transient,
  // retryable failure, and it was being classified as malicious input and dropped.
  const { BadInputError, isBadInputError } = require('../src/errors');

  it('classifies a typed BadInputError as bad input', () => {
    expect(isBadInputError(new BadInputError('Validation Failed for PromptSubmitted'))).to.be.true;
  });

  it('does NOT drop a gateway outage that merely looks like a parse error', () => {
    // Exactly what JSON.parse throws when a gateway returns an HTML error page.
    const outage = new SyntaxError(
      `Unexpected token '<', "<html><body>502 Bad Gateway" is not valid JSON`,
    );

    expect(isBadInputError(outage)).to.be.false;
  });

  it('does NOT drop an unrelated error quoting a validation phrase', () => {
    const unrelated = new Error('Upstream said: Validation Failed on their side');

    expect(isBadInputError(unrelated)).to.be.false;
  });

  it('treats a malformed encrypted payload as bad input', () => {
    // Genuinely user-supplied and genuinely unretryable — must still be dropped.
    expect(
      isBadInputError(new BadInputError('Invalid encrypted data format. Expected "iv.encryptedData".')),
    ).to.be.true;
  });

  it('is not fooled by a null or message-less error', () => {
    expect(isBadInputError(null)).to.be.false;
    expect(isBadInputError(undefined)).to.be.false;
    expect(isBadInputError({})).to.be.false;
  });
});

describe('security hardening — GraphQL tag escaping', () => {
  const { buildTagQuery } = require('../src/storage/arweave');

  // Tag values are interpolated straight into a GraphQL document. Today's only callers pass
  // `${chainId}-${conversationId}`, both chain-derived, so this is LATENT rather than live — but
  // the function's signature accepts arbitrary tags and nothing stops a future caller passing
  // text from a prompt.
  it('escapes a quote so a value cannot close its own string literal', () => {
    const query = buildTagQuery([{ name: 'Content-Type', value: 'a" }] , first: 999 #' }]);

    expect(query).to.not.include('a" }]');
    expect(query).to.include('\\"');
  });

  it('escapes backslashes and newlines', () => {
    const query = buildTagQuery([{ name: 'n', value: 'a\\b\nc' }]);

    expect(query).to.include('\\\\');
    expect(query).to.not.include('a\\b\nc');
  });

  it('escapes the tag NAME as well as the value', () => {
    const query = buildTagQuery([{ name: 'bad" name', value: 'v' }]);

    expect(query).to.include('\\"');
  });

  it('still produces a working query for ordinary tags', () => {
    const query = buildTagQuery([
      { name: 'Content-Type', value: 'application/rofl-key' },
      { name: 'SenseAI-Key-For-Conversation', value: '8453-42' },
    ]);

    expect(query).to.include('{ name: "Content-Type", values: ["application/rofl-key"] }');
    expect(query).to.include('{ name: "SenseAI-Key-For-Conversation", values: ["8453-42"] }');
    expect(query).to.include('first: 1');
  });

  it('rejects a non-string tag field rather than coercing it into the document', () => {
    expect(() => buildTagQuery([{ name: 'n', value: { nested: 'obj' } }])).to.throw();
  });
});
