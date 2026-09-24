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
});
