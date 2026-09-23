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

  it('keeps publicKey, which is the case the specific-entry list exists to protect', () => {
    // Asserted explicitly: the fixture above contained publicKey but never checked it, so the
    // docstring's central claim -- that entries are specific rather than a bare "key" -- was
    // untested.
    expect(scrubSensitiveData({ publicKey: '0x04abc' }).publicKey).to.equal('0x04abc');
  });

  // Everything below is a way the scrubber THROWS or LOSES DATA. A throw out of beforeSend is
  // not a crash you see -- Sentry drops the event silently, so the failure mode is total
  // blindness at exactly the moment something is going wrong.

  it('survives nesting deeper than the stack, which is not circular at all', () => {
    // The WeakSet guards cycles only. A deep ACYCLIC object -- a long cause chain, a big
    // decoded payload -- recursed to RangeError with no cycle anywhere in it.
    let deep = { leaf: true };
    for (let i = 0; i < 50_000; i += 1) deep = { nested: deep };

    expect(() => scrubSensitiveData(deep)).to.not.throw();
  });

  it('survives a property whose getter throws', () => {
    // Spreading an object INVOKES its getters. Error objects from third-party libraries do
    // carry lazy accessors, and one that throws took the whole event with it.
    const hostile = { safe: 1 };
    Object.defineProperty(hostile, 'boom', {
      enumerable: true,
      get() {
        throw new Error('getter exploded');
      },
    });

    expect(() => scrubSensitiveData(hostile)).to.not.throw();
  });

  it('survives a proxy that refuses to enumerate', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('no keys for you');
        },
      },
    );

    expect(() => scrubSensitiveData({ payload: hostile })).to.not.throw();
  });

  it('does not report shared references as circular', () => {
    // A diamond is not a cycle. Sentry events routinely share sub-objects between contexts, and
    // a global seen-set marks the second visit as [CIRCULAR] -- silently deleting real data
    // from the report.
    const shared = { detail: 'kept' };

    const result = scrubSensitiveData({ a: shared, b: shared });

    expect(result.a).to.deep.equal({ detail: 'kept' });
    expect(result.b).to.deep.equal({ detail: 'kept' });
  });

  it('redacts a symbol-keyed secret', () => {
    // Object.keys does not see symbols, but the spread COPIES them -- so the value survived
    // into the event untouched.
    const key = Symbol('PRIVATE_KEY');

    expect(scrubSensitiveData({ [key]: 'sk-leak' })[key]).to.equal('[REDACTED]');
  });

  it('keeps token telemetry, which is not a credential', () => {
    // A bare "token" entry redacts exactly the fields you debug a token-gated agent with. The
    // list's own docstring argues against bare matches; this holds it to that.
    const result = scrubSensitiveData({
      tokenAddress: '0xABLE',
      tokenId: 7,
      promptTokens: 120,
      totalTokens: 340,
      ableToken: '0xABLE',
    });

    expect(result.tokenAddress).to.equal('0xABLE');
    expect(result.tokenId).to.equal(7);
    expect(result.promptTokens).to.equal(120);
    expect(result.totalTokens).to.equal(340);
    expect(result.ableToken).to.equal('0xABLE');
  });

  it("redacts this project's own secret-bearing field names", () => {
    // sessionKey is not a generic guess: it is a declared field in payloadValidator's schemas
    // and is read off the prompt path, so it is the single most likely secret to be attached
    // to a Sentry `extra`. The list was rebuilt without it.
    const result = scrubSensitiveData({
      sessionKey: 'a',
      SESSION_KEY: 'b',
      signingKey: 'c',
      ENCRYPTION_KEY: 'd',
      seedPhrase: 'e',
    });

    for (const k of Object.keys(result)) {
      expect(result[k], k).to.equal('[REDACTED]');
    }
  });

  it('keeps benign seed fields, which are not credentials', () => {
    // The same trap as the bare "token" entry: this codebase carries contentSeed, numericSeed
    // and initialRandomSeed, so the entry is "seedphrase" rather than "seed".
    const result = scrubSensitiveData({ contentSeed: 1, numericSeed: 2, initialRandomSeed: 3 });

    expect(result.contentSeed).to.equal(1);
    expect(result.numericSeed).to.equal(2);
    expect(result.initialRandomSeed).to.equal(3);
  });

  it('still redacts the credential-shaped token names', () => {
    const result = scrubSensitiveData({
      SLACK_ACCESS_TOKEN: 'a',
      authToken: 'b',
      bearerToken: 'c',
      refreshToken: 'd',
      TRADABLE_API_ACCESS_TOKEN: 'e',
    });

    for (const k of Object.keys(result)) {
      expect(result[k], k).to.equal('[REDACTED]');
    }
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

  // decryptSymmetrically parses the DECRYPTED payload. A user holds their own session key, so
  // they can encrypt arbitrary bytes that pass AES-GCM authentication and still aren't JSON.
  //
  // Before this predicate was typed, the old message match on "Unexpected token" covered this
  // parse by accident and the event was dropped quietly — correct behaviour. Typing it without
  // typing this site regresses that: a plain SyntaxError is no longer bad input, isn't retryable
  // either, and falls through to the FATAL branch — Sentry, a Slack "CRITICAL: Oracle Fatal
  // Error", and an answer_failed metric, one per malformed prompt. Exactly the attacker-driven
  // inflation the !isBadInputError gates exist to prevent.
  const crypto = require('node:crypto');
  const { ethers } = require('ethers');

  // aiAgentOracle initialises a wallet at module load, so it needs a usable PRIVATE_KEY and is
  // required fresh here rather than at file scope — same pattern as failedJobsProbe.test.js,
  // including restoring whatever another suite left in the environment.
  let decryptSymmetrically;
  let savedEnv;

  before(() => {
    const wallet = ethers.Wallet.createRandom();
    savedEnv = {
      pk: process.env.PRIVATE_KEY,
      addr: process.env.AI_AGENT_CONTRACT_ADDRESS,
    };
    process.env.PRIVATE_KEY = wallet.privateKey;
    process.env.AI_AGENT_CONTRACT_ADDRESS = wallet.address;
    delete require.cache[require.resolve('../src/aiAgentOracle')];
    ({ decryptSymmetrically } = require('../src/aiAgentOracle'));
  });

  after(() => {
    if (savedEnv.pk === undefined) delete process.env.PRIVATE_KEY;
    else process.env.PRIVATE_KEY = savedEnv.pk;
    if (savedEnv.addr === undefined) delete process.env.AI_AGENT_CONTRACT_ADDRESS;
    else process.env.AI_AGENT_CONTRACT_ADDRESS = savedEnv.addr;
    delete require.cache[require.resolve('../src/aiAgentOracle')];
  });

  /** Encrypts arbitrary bytes the way a client would, so the auth tag is valid. */
  function sealForOracle(plaintext, key) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
    const combined = Buffer.concat([body, cipher.getAuthTag()]);
    return `${iv.toString('base64')}.${combined.toString('base64')}`;
  }

  it('treats a well-encrypted payload that is not JSON as bad input', () => {
    const key = crypto.randomBytes(32);
    const sealed = sealForOracle('this decrypts cleanly but is not JSON', key);

    let thrown;
    try {
      decryptSymmetrically(sealed, key);
    } catch (error) {
      thrown = error;
    }

    expect(thrown, 'expected a throw').to.exist;
    expect(isBadInputError(thrown)).to.be.true;
  });

  it('still decrypts a valid JSON payload unchanged', () => {
    const key = crypto.randomBytes(32);
    const sealed = sealForOracle(JSON.stringify({ sessionKey: '0xabc', n: 1 }), key);

    expect(decryptSymmetrically(sealed, key)).to.deep.equal({ sessionKey: '0xabc', n: 1 });
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
