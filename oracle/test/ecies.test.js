'use strict';

const { expect, use } = require('chai');
const chaiAsPromised = require('chai-as-promised');
use(chaiAsPromised.default ?? chaiAsPromised);

// Valid secp256k1 private keys (< curve order)
const PRIV_1 = '11'.repeat(32);
const PRIV_2 = '22'.repeat(32);
const PRIV_3 = '33'.repeat(32);
const PRIV_4 = '44'.repeat(32);
const PRIV_5 = '55'.repeat(32);

describe('ecies', () => {
	let ecies;

	before(() => {
		ecies = require('../src/ecies');
	});

	describe('publicKeyFromPrivateKey', () => {
		it('returns 130-char hex starting with 04', () => {
			const pub = ecies.publicKeyFromPrivateKey(PRIV_1);
			expect(pub).to.be.a('string');
			expect(pub.length).to.equal(130);
			expect(pub.startsWith('04')).to.be.true;
		});

		it('accepts private key with 0x prefix', () => {
			const pub = ecies.publicKeyFromPrivateKey('0x' + PRIV_2);
			expect(pub.length).to.equal(130);
		});
	});

	describe('eciesEncrypt + eciesDecrypt round-trip', () => {
		it('decrypts to original 32-byte session key', async () => {
			const pubKey = ecies.publicKeyFromPrivateKey(PRIV_1);
			const sessionKey = Buffer.alloc(32, 0x42);

			const cipherBlob = await ecies.eciesEncrypt(pubKey, sessionKey);
			const recovered = await ecies.eciesDecrypt(PRIV_1, cipherBlob);

			expect(Buffer.from(recovered)).to.deep.equal(sessionKey);
		});

		it('round-trip works with arbitrary plaintext', async () => {
			const pubKey = ecies.publicKeyFromPrivateKey(PRIV_2);
			const plaintext = Buffer.from('hello world from oracle ecies test');

			const cipher = await ecies.eciesEncrypt(pubKey, plaintext);
			const recovered = await ecies.eciesDecrypt(PRIV_2, cipher);

			expect(recovered.toString()).to.equal('hello world from oracle ecies test');
		});
	});

	describe('cipherBlob format', () => {
		it('has version byte 0x01 as first byte', async () => {
			const pubKey = ecies.publicKeyFromPrivateKey(PRIV_3);
			const cipher = await ecies.eciesEncrypt(pubKey, Buffer.alloc(32));

			expect(cipher[0]).to.equal(0x01);
		});

		it('is at least 94 bytes (1 version + 65 ephemPubKey + 12 nonce + 16 tag)', async () => {
			const pubKey = ecies.publicKeyFromPrivateKey(PRIV_4);
			const cipher = await ecies.eciesEncrypt(pubKey, Buffer.alloc(0));

			expect(cipher.length).to.be.at.least(94);
		});

		it('produces different ciphertext each call (randomness)', async () => {
			const pubKey = ecies.publicKeyFromPrivateKey(PRIV_5);
			const plaintext = Buffer.alloc(32, 0xff);

			const c1 = await ecies.eciesEncrypt(pubKey, plaintext);
			const c2 = await ecies.eciesEncrypt(pubKey, plaintext);

			expect(c1.toString('hex')).to.not.equal(c2.toString('hex'));
		});
	});

	describe('eciesDecrypt error handling', () => {
		it('throws on unsupported version byte', async () => {
			const badBlob = Buffer.alloc(100, 0);
			badBlob[0] = 0x02;

			await expect(ecies.eciesDecrypt(PRIV_1, badBlob)).to.be.rejectedWith(
				'eciesDecrypt: unsupported version byte 0x2',
			);
		});

		it('throws on ciphertext shorter than minimum 94 bytes', async () => {
			const shortBlob = Buffer.alloc(93, 0);
			shortBlob[0] = 0x01;

			await expect(ecies.eciesDecrypt(PRIV_1, shortBlob)).to.be.rejectedWith(
				'eciesDecrypt: ciphertext too short (93 bytes, minimum 94)',
			);
		});

		it('accepts public key with 0x04 prefix', async () => {
			const pubRaw = ecies.publicKeyFromPrivateKey(PRIV_1);
			const pubWith0x04 = '0x04' + pubRaw.slice(2);

			const plaintext = Buffer.from([1, 2, 3]);
			const cipher = await ecies.eciesEncrypt(pubWith0x04, plaintext);
			const recovered = await ecies.eciesDecrypt(PRIV_1, cipher);

			expect(Buffer.from(recovered)).to.deep.equal(plaintext);
		});
	});
});
