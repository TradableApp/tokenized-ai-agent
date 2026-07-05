/**
 * Bootstraps Postgres connectivity for the Brain's warm-cache reads — the
 * Oracle-body port of sense-ai-core's `src/utils/postgresBootstrap.ts`
 * (Phase 2, CU-86d3dwme6). Cloud SQL is configured for
 * TRUSTED_CLIENT_CERTIFICATE_REQUIRED (mTLS), so cert sources are resolved
 * and appended as libpq `sslcert`/`sslkey`/`sslrootcert` query params on
 * `POSTGRES_URL` — node-postgres picks them up via pg-connection-string.
 *
 * Cert resolution per cert: `POSTGRES_*_PATH` (file, local dev) beats
 * `POSTGRES_*` (inline PEM or base64 PEM — the ROFL on-chain secret format;
 * base64 because docker-compose env substitution truncates multi-line values).
 */
const { chmodSync, existsSync, lstatSync, mkdirSync, statSync, writeFileSync } = require("node:fs");
const { homedir, tmpdir } = require("node:os");
const { join } = require("node:path");

const REQUIRED_BASE_KEYS = [
  "POSTGRES_HOST",
  "POSTGRES_PORT",
  "POSTGRES_DATABASE",
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
];

const DEFAULT_SSL_MODE = "verify-ca";
const DEFAULT_CERT_DIR = join(tmpdir(), "senseai-oracle-postgres-certs");

/**
 * Resolves a single cert input to a file path libpq can read.
 * @returns {string} path to the materialized (or user-provided) cert file
 */
function resolveCert(inlineKey, pathKey, fileName, certDir, isPrivateKey) {
  const pathOverride = process.env[pathKey];
  if (pathOverride) {
    const expanded = pathOverride.startsWith("~/")
      ? join(homedir(), pathOverride.slice(2))
      : pathOverride;
    if (!existsSync(expanded)) {
      throw new Error(`${pathKey} points to ${expanded} which does not exist`);
    }
    if (isPrivateKey) {
      // ONE lstat (doesn't follow symlinks), checks ordered so each failure
      // gets its dedicated message: symlink (TOCTOU) → regular file → 0600.
      const linkStats = lstatSync(expanded);
      if (linkStats.isSymbolicLink()) {
        throw new Error(
          `${pathKey} (${expanded}) is a symlink — refusing for security (TOCTOU on link target). ` +
            `Point ${pathKey} at the real key file.`,
        );
      }
      if (!linkStats.isFile()) {
        throw new Error(`${pathKey} (${expanded}) is not a regular file`);
      }
      const mode = linkStats.mode & 0o777;
      if (mode & 0o077) {
        throw new Error(
          `${pathKey} (${expanded}) has world/group permissions ${mode.toString(8)} — node-postgres requires 0600. ` +
            `Run: chmod 600 ${expanded}`,
        );
      }
    } else if (!statSync(expanded).isFile()) {
      // Non-key certs may be symlinks (statSync follows them) but must resolve
      // to a regular file — directories/sockets fail fast here instead of as a
      // cryptic libpq error later.
      throw new Error(`${pathKey} (${expanded}) is not a regular file`);
    }
    return expanded;
  }

  const inline = process.env[inlineKey];
  if (!inline) {
    throw new Error(`Either ${inlineKey} (inline PEM) or ${pathKey} (file path) is required`);
  }

  // Auto-detect format: raw PEM (with \n-escape normalization for hand-pasted
  // single-line entries) vs base64-encoded PEM (the ROFL secret transport).
  let normalized;
  if (inline.trimStart().startsWith("-----BEGIN")) {
    normalized = inline.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n");
  } else {
    const decoded = Buffer.from(inline.trim(), "base64").toString("utf8");
    if (!decoded.includes("-----BEGIN")) {
      throw new Error(
        `${inlineKey} is neither raw PEM (no -----BEGIN prefix) nor valid base64-encoded PEM`,
      );
    }
    normalized = decoded;
  }

  mkdirSync(certDir, { recursive: true });
  const filePath = join(certDir, fileName);
  if (isPrivateKey) {
    writeFileSync(filePath, normalized, { mode: 0o600 });
    chmodSync(filePath, 0o600); // belt + braces — some FS umasks ignore mode
  } else {
    writeFileSync(filePath, normalized);
  }
  return filePath;
}

/**
 * Reads POSTGRES_* env config, materializes certs, and stamps
 * `process.env.POSTGRES_URL`. Must run before anything reads POSTGRES_URL.
 */
function bootstrapPostgresFromEnv(options = {}) {
  // Trim-check catches whitespace-only values that would produce a malformed URL.
  for (const key of REQUIRED_BASE_KEYS) {
    const val = process.env[key];
    if (!val || val.trim().length === 0) {
      throw new Error(`${key} is required to bootstrap Postgres`);
    }
  }

  const certDir = options.certDir ?? DEFAULT_CERT_DIR;

  const clientCert = resolveCert(
    "POSTGRES_CLIENT_CERT",
    "POSTGRES_CLIENT_CERT_PATH",
    "client.crt",
    certDir,
    false,
  );
  const clientKey = resolveCert(
    "POSTGRES_CLIENT_KEY",
    "POSTGRES_CLIENT_KEY_PATH",
    "client.key",
    certDir,
    true,
  );
  const serverCa = resolveCert(
    "POSTGRES_SERVER_CA_CERT",
    "POSTGRES_SERVER_CA_CERT_PATH",
    "server-ca.crt",
    certDir,
    false,
  );

  const sslMode = process.env.POSTGRES_SSL_MODE || DEFAULT_SSL_MODE;
  const url = new URL(
    `postgresql://${encodeURIComponent(process.env.POSTGRES_USER ?? "")}` +
      `:${encodeURIComponent(process.env.POSTGRES_PASSWORD ?? "")}` +
      `@${process.env.POSTGRES_HOST}` +
      `:${process.env.POSTGRES_PORT}` +
      `/${encodeURIComponent(process.env.POSTGRES_DATABASE ?? "")}`,
  );
  url.searchParams.set("sslmode", sslMode);
  url.searchParams.set("sslcert", clientCert);
  url.searchParams.set("sslkey", clientKey);
  url.searchParams.set("sslrootcert", serverCa);
  // Force libpq-compatible sslmode interpretation — without this, verify-ca is
  // silently treated as verify-full (hostname check), which fails for Cloud SQL
  // public-IP connections (server cert SAN is GCP's internal hostname).
  url.searchParams.set("uselibpqcompat", "true");

  process.env.POSTGRES_URL = url.toString();
}

module.exports = { bootstrapPostgresFromEnv };
