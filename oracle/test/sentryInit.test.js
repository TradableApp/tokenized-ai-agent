'use strict';

const { expect } = require('chai');
const { scrubSensitiveData } = require('../src/sentryInit');

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

  describe('beforeSend, when the scrubber itself throws', () => {
    const proxyquire = require('proxyquire');

    // The scrubber guards throwing getters, so the only way into beforeSend's catch is a trap it
    // does not run inside a try: `getOwnPropertyDescriptor`. That is also the honest case — the
    // error's MESSAGE is built by the hostile object, so it can carry exactly what the scrubber
    // exists to remove, which is why only the constructor name and the frames may be logged.
    function callBeforeSendWithAHostileEvent(secret) {
      let beforeSend;
      const { initSentry } = proxyquire('../src/sentryInit', {
        '@sentry/node': { init: (options) => { beforeSend = options.beforeSend; } },
      });

      const savedDsn = process.env.SENTRY_DSN;
      process.env.SENTRY_DSN = 'https://public@o0.ingest.sentry.io/0';
      const savedError = console.error;
      const logged = [];
      console.error = (...args) => logged.push(args);

      try {
        initSentry();
        const hostile = new Proxy(
          { a: 1 },
          {
            getOwnPropertyDescriptor() {
              throw new Error(`context dump: ${secret}`);
            },
          },
        );

        return { result: beforeSend({ event_id: 'e1', timestamp: 1, extra: hostile }), logged };
      } finally {
        console.error = savedError;
        if (savedDsn === undefined) delete process.env.SENTRY_DSN;
        else process.env.SENTRY_DSN = savedDsn;
      }
    }

    it('logs the frames without the error message, which can carry the secret', () => {
      const secret = 'MNEMONIC-abandon-abandon-ability';
      const { logged } = callBeforeSendWithAHostileEvent(secret);

      expect(logged, 'expected the failure to be logged').to.have.lengthOf(1);
      const [, errorName, frames] = logged[0];
      expect(errorName).to.equal('Error');
      expect(frames).to.match(/^\s*at /, 'expected stack frames, starting past the message line');
      expect(JSON.stringify(logged)).to.not.include(secret);
    });

    it('still returns a redacted stand-in rather than dropping the event', () => {
      const { result } = callBeforeSendWithAHostileEvent('irrelevant');

      expect(result.event_id).to.equal('e1');
      expect(result.message).to.include('withheld');
      expect(result).to.not.have.property('extra');
    });
  });
});
