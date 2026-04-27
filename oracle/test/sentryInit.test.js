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
});
