/**
 * Wire-format helpers shared by the smoke's prompt runner: the dApp's AES-256-GCM MessageFile
 * encoding and the storage-gateway fetch. Moved verbatim out of base-testnet-smoke.js when the
 * runner grew burst and injection modes; behaviour unchanged.
 */
const crypto = require("node:crypto");

/** Mirrors dApp src/lib/crypto.ts: `base64(iv).base64(ct+tag)`. */
function aesGcmEncrypt(keyBytes, obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyBytes, iv);
  const ct = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(obj), "utf8")),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${Buffer.concat([ct, tag]).toString("base64")}`;
}

function aesGcmDecrypt(keyBytes, str) {
  const [ivB64, dataB64] = str.split(".");
  const iv = Buffer.from(ivB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  const tag = data.subarray(data.length - 16);
  const ct = data.subarray(0, data.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyBytes, iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8"));
}

/** Mirrors dApp syncService.getStorageProvider. */
function gatewayUrl(cid, { storageGatewayUrl } = {}) {
  // Prefix-only match: AutoDrive CIDv1 base32 length can shift with codec/hash changes, so don't
  // hard-code the char count. Irys (43-44 base64url) can't collide with a bafkr6i-prefixed
  // base32 CID, so it's still a safe guard below.
  if (/^bafkr6i/.test(cid)) return `https://gateway.autonomys.xyz/file/${cid}`; // Autonomys
  if (/^[A-Za-z0-9_-]{43,44}$/.test(cid)) return `https://gateway.irys.xyz/${cid}`; // Irys/Arweave
  if (/^bafy/.test(cid) && storageGatewayUrl) return `${storageGatewayUrl}${cid}`; // IPFS/localnet
  throw new Error(`Unrecognised CID format: ${cid}`);
}

/**
 * Fetches the encrypted MessageFile string (`iv.ct`) stored under a CID.
 *
 * Bounds the whole fetch (headers AND body read) with an AbortSignal — the poll timeout only
 * guards the event wait, so a hung gateway here would otherwise hang the process. clearTimeout in
 * finally, after .text(), so the signal stays live through the body stream too.
 */
async function fetchEncrypted(cid, { fetchTimeoutMs, storageGatewayUrl }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), fetchTimeoutMs);
  try {
    const res = await fetch(gatewayUrl(cid, { storageGatewayUrl }), { signal: ctrl.signal });
    if (!res.ok) throw new Error(`storage fetch ${res.status} for ${cid}`);
    const text = (await res.text()).trim();
    // Some providers wrap the stored string in JSON — unwrap if so, and fail LOUDLY on an
    // unexpected shape rather than passing raw JSON to aesGcmDecrypt (which would throw a
    // misleading GCM auth-tag error instead of a clear storage-format error).
    if (text.startsWith("{")) {
      const j = JSON.parse(text);
      const inner = j.encryptedContent ?? j.content ?? j.data;
      if (inner == null)
        throw new Error(
          `storage file has unexpected JSON shape, keys: ${Object.keys(j).join(", ")}`,
        );
      return inner;
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { aesGcmEncrypt, aesGcmDecrypt, gatewayUrl, fetchEncrypted };
