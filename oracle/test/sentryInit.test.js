'use strict';

const { expect } = require('chai');
const { scrubSensitiveData, redactedStandIn } = require('../src/sentryInit');

describe('sentryInit', () => {
  describe('scrubSensitiveData', () => {
    it('redacts top-level sensitive keys', () => {
      const result = scrubSensitiveData({ privateKey: 'secret', message: 'ok' });
      expect(result.privateKey).to.equal('[REDACTED]');
      expect(result.message).to.equal('ok');
    });

    it('redacts all 7 sensitive key patterns', () => {
      const input = {
        AI_AGENT_PRIVATE_KEY: 'a',
        AUTONOMYS_MNEMONIC: 'b',
        IRYS_KEY: 'c',
        privateKey: 'd',
        mnemonic: 'e',
        encryptedPayload: 'f',
        roflEncryptedKey: 'g',
        safe: 'h',
      };
      const result = scrubSensitiveData(input);
      expect(result.AI_AGENT_PRIVATE_KEY).to.equal('[REDACTED]');
      expect(result.AUTONOMYS_MNEMONIC).to.equal('[REDACTED]');
      expect(result.IRYS_KEY).to.equal('[REDACTED]');
      expect(result.privateKey).to.equal('[REDACTED]');
      expect(result.mnemonic).to.equal('[REDACTED]');
      expect(result.encryptedPayload).to.equal('[REDACTED]');
      expect(result.roflEncryptedKey).to.equal('[REDACTED]');
      expect(result.safe).to.equal('h');
    });

    it('redacts sensitive keys nested inside objects', () => {
      const result = scrubSensitiveData({ context: { user: { privateKey: 'secret' } } });
      expect(result.context.user.privateKey).to.equal('[REDACTED]');
    });

    it('redacts sensitive keys inside arrays of objects', () => {
      const result = scrubSensitiveData({ items: [{ mnemonic: 'secret' }, { safe: 'value' }] });
      expect(result.items[0].mnemonic).to.equal('[REDACTED]');
      expect(result.items[1].safe).to.equal('value');
    });

    it('does not mutate the original object', () => {
      const original = { privateKey: 'secret' };
      scrubSensitiveData(original);
      expect(original.privateKey).to.equal('secret');
    });

    it('matches keys by substring (e.g. myPrivateKey)', () => {
      const result = scrubSensitiveData({ myPrivateKey: 'secret', walletPrivateKey: 'also-secret' });
      expect(result.myPrivateKey).to.equal('[REDACTED]');
      expect(result.walletPrivateKey).to.equal('[REDACTED]');
    });

    it('removes the address of a request from text at any depth', () => {
      const result = scrubSensitiveData({
        message: 'GET https://rpc.example/v2/not-a-real-key failed',
        exception: { values: [{ value: 'missing response (url="https://rpc.example/v2/not-a-real-key")' }] },
        breadcrumbs: [{ data: { url: 'https://rpc.example/v2/not-a-real-key', status_code: 503 } }],
      });

      expect(JSON.stringify(result)).to.not.include('rpc.example');
      expect(result.message).to.equal('GET [address removed] failed');
      expect(result.breadcrumbs[0].data.status_code).to.equal(503);
    });

    it('returns non-object values unchanged', () => {
      expect(scrubSensitiveData(null)).to.equal(null);
      expect(scrubSensitiveData('string')).to.equal('string');
      expect(scrubSensitiveData(42)).to.equal(42);
    });

    it('handles empty objects and arrays without throwing', () => {
      expect(scrubSensitiveData({})).to.deep.equal({});
      expect(scrubSensitiveData([])).to.deep.equal([]);
    });
  });

  describe('a Proxy whose descriptor trap throws', () => {
    // The last Proxy hook that ran outside a guard. It fires before the getter, so an unguarded
    // throw here unwound the whole scrub and cost the entire event — the opposite of the
    // per-field degradation the scrubber is built for.
    function hostile() {
      return new Proxy(
        { a: 1 },
        {
          getOwnPropertyDescriptor() {
            throw new Error('descriptor trap');
          },
        },
      );
    }

    it('degrades the hostile field rather than the whole event', () => {
      const result = scrubSensitiveData({ safe: 'kept', payload: hostile() });

      expect(result.safe).to.equal('kept');
      expect(result.payload.a).to.equal('[UNREADABLE]');
    });

    it('does not throw out of the scrubber at any depth', () => {
      expect(() => scrubSensitiveData({ a: { b: { c: hostile() } } })).to.not.throw();
    });
  });

  describe('redactedStandIn', () => {
    // The scrubber is written not to throw, and with the descriptor trap guarded there is no
    // input that makes it. This is the last line of defence behind that, so it is exercised
    // directly rather than through an input that can no longer reach it.
    function capture(error) {
      const savedError = console.error;
      const logged = [];
      console.error = (...args) => logged.push(args);

      try {
        return { result: redactedStandIn({ event_id: 'e1', timestamp: 1 }, error), logged };
      } finally {
        console.error = savedError;
      }
    }

    it('logs the frames without the message, which can carry the secret', () => {
      const secret = 'MNEMONIC-abandon-abandon-ability';
      const { logged } = capture(new Error(`context dump: ${secret}`));

      expect(logged).to.have.lengthOf(1);
      const [, errorName, frames] = logged[0];
      expect(errorName).to.equal('Error');
      expect(frames).to.match(/^\s*at /, 'expected frames, starting past the message line');
      expect(JSON.stringify(logged)).to.not.include(secret);
    });

    it('returns a stand-in carrying no part of the original event', () => {
      const { result } = capture(new Error('whatever'));

      expect(result.event_id).to.equal('e1');
      expect(result.message).to.include('withheld');
      expect(result).to.not.have.property('extra');
    });
  });

  describe('initSentry', () => {
    const sinon = require('sinon');
    const proxyquire = require('proxyquire');

    const initWith = () => {
      const sentry = {
        init: sinon.stub(),
        onUnhandledRejectionIntegration: sinon.stub().callsFake((options) => ({
          name: 'OnUnhandledRejection',
          options,
        })),
      };
      const previous = process.env.SENTRY_DSN;
      process.env.SENTRY_DSN = 'https://public@sentry.example/1';
      const log = sinon.stub(console, 'log');
      try {
        proxyquire('../src/sentryInit', { '@sentry/node': sentry }).initSentry();
      } finally {
        log.restore();
        if (previous === undefined) delete process.env.SENTRY_DSN;
        else process.env.SENTRY_DSN = previous;
      }
      return sentry.init.firstCall.args[0];
    };

    it('tells Sentry not to print an unhandled rejection itself', () => {
      // Sentry's default prints the rejection's stack as it is; the process's own handler
      // prints the described error.
      const options = initWith();

      const integration = options.integrations.find((i) => i.name === 'OnUnhandledRejection');
      expect(integration.options).to.deep.equal({ mode: 'none' });
    });

    it('scrubs transactions as it scrubs events', () => {
      const options = initWith();

      const scrubbed = options.beforeSendTransaction({
        spans: [{ data: { 'url.full': 'https://rpc.example/v2/not-a-real-key' } }],
      });
      expect(JSON.stringify(scrubbed)).to.not.include('rpc.example');
    });
  });

  describe('the oracle\'s own keys', () => {
    const { registerSecretValue, forgetSecretValuesForTest } = require('../src/secretValues');
    const KEY = '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

    afterEach(() => forgetSecretValuesForTest());

    it('redacts fields named for the decryption key or key material', () => {
      const result = scrubSensitiveData({ decryptionKey: 'a', key_material: 'b', keyId: 'c' });

      expect(result.decryptionKey).to.equal('[REDACTED]');
      expect(result.key_material).to.equal('[REDACTED]');
      expect(result.keyId).to.equal('c');
    });

    it('removes a registered key from any text, whatever the field is called', () => {
      registerSecretValue(KEY);

      const result = scrubSensitiveData({
        message: `could not use ${KEY}`,
        exception: { values: [{ type: 'Error', value: `bad 0x${KEY.toUpperCase()}` }] },
        breadcrumbs: [{ message: KEY }],
      });

      expect(JSON.stringify(result)).to.not.include(KEY);
      expect(JSON.stringify(result).toLowerCase()).to.not.include(KEY);
      expect(result.message).to.equal('could not use [REDACTED]');
    });

    it('removes a registered key held as bytes', () => {
      registerSecretValue(KEY);
      const bytes = Buffer.from(KEY, 'hex');

      const result = scrubSensitiveData({ extra: { raw: new Uint8Array(bytes), buffer: bytes } });

      expect(result.extra.raw).to.equal('[REDACTED]');
      expect(result.extra.buffer).to.equal('[REDACTED]');
    });

    it('leaves other bytes as they were', () => {
      registerSecretValue(KEY);

      const result = scrubSensitiveData({ extra: { raw: new Uint8Array([1, 2, 3]) } });

      expect(Array.from(Object.values(result.extra.raw))).to.deep.equal([1, 2, 3]);
    });
  });
});
