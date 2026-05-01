'use strict';

const { secp256k1 } = require('@noble/curves/secp256k1.js');
const { gcm } = require('@noble/ciphers/aes.js');
const { sha256 } = require('@noble/hashes/sha2.js');
const crypto = require('crypto');

function stripHexPrefix(hex) {
	return hex.startsWith('0x') ? hex.slice(2) : hex;
}

function normPubKeyBytes(pubKeyHex) {
	const h = stripHexPrefix(pubKeyHex.startsWith('0x04') ? '04' + pubKeyHex.slice(4) : pubKeyHex);
	const full = h.length === 128 ? '04' + h : h;
	return new Uint8Array(Buffer.from(full, 'hex'));
}

function publicKeyFromPrivateKey(privateKeyHex) {
	const privBytes = new Uint8Array(Buffer.from(stripHexPrefix(privateKeyHex), 'hex'));
	const pubBytes = secp256k1.getPublicKey(privBytes, false);
	return Buffer.from(pubBytes).toString('hex');
}

async function eciesEncrypt(recipientPubKeyHex, plaintext) {
	const pubKeyBytes = normPubKeyBytes(recipientPubKeyHex);
	const ephemPrivKey = secp256k1.utils.randomSecretKey();
	const ephemPubKey = secp256k1.getPublicKey(ephemPrivKey, false);
	const sharedSecret = secp256k1.getSharedSecret(ephemPrivKey, pubKeyBytes, true);
	const symmetricKey = sha256(sharedSecret.slice(1, 33));
	const nonce = crypto.randomBytes(12);
	const payload = Buffer.isBuffer(plaintext) ? new Uint8Array(plaintext) : plaintext;
	const gcmOutput = gcm(symmetricKey, nonce).encrypt(payload);
	return Buffer.concat([Buffer.from([0x01]), Buffer.from(ephemPubKey), nonce, Buffer.from(gcmOutput)]);
}

async function eciesDecrypt(privateKeyHex, cipherBlob) {
	const buf = Buffer.isBuffer(cipherBlob) ? cipherBlob : Buffer.from(cipherBlob);
	if (buf[0] !== 0x01) throw new Error(`eciesDecrypt: unsupported version byte 0x${buf[0].toString(16)}`);
	if (buf.length < 94) throw new Error(`eciesDecrypt: ciphertext too short (${buf.length} bytes, minimum 94)`);
	const ephemPubKey = new Uint8Array(buf.slice(1, 66));
	const nonce = new Uint8Array(buf.slice(66, 78));
	const gcmOutput = new Uint8Array(buf.slice(78));
	const privBytes = new Uint8Array(Buffer.from(stripHexPrefix(privateKeyHex), 'hex'));
	const sharedSecret = secp256k1.getSharedSecret(privBytes, ephemPubKey, true);
	const symmetricKey = sha256(sharedSecret.slice(1, 33));
	const plaintext = gcm(symmetricKey, nonce).decrypt(gcmOutput);
	return Buffer.from(plaintext);
}

module.exports = { eciesEncrypt, eciesDecrypt, publicKeyFromPrivateKey };
