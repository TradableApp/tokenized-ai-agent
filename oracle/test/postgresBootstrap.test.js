const { expect } = require("chai");
const { mkdtempSync, writeFileSync, readFileSync, existsSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

// Port of sense-ai-core's postgresBootstrap (Cloud SQL mTLS bridge) for the
// Oracle body — Phase 2 of the Oracle Brain migration (CU-86d3dwme6). The
// Brain reads the shared warm cache in Cloud SQL; libpq-style sslcert/sslkey/
// sslrootcert query params are stamped onto POSTGRES_URL.

const { bootstrapPostgresFromEnv } = require("../src/postgresBootstrap");

const PEM_STUB = "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n";
const KEY_STUB = "-----BEGIN PRIVATE KEY-----\nxyz\n-----END PRIVATE KEY-----\n";

function setBaseEnv() {
  process.env.POSTGRES_HOST = "10.0.0.5";
  process.env.POSTGRES_PORT = "5432";
  process.env.POSTGRES_DATABASE = "senseai";
  process.env.POSTGRES_USER = "senseai";
  process.env.POSTGRES_PASSWORD = "p@ss word";
}

function clearPostgresEnv() {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("POSTGRES_")) delete process.env[key];
  }
}

describe("postgresBootstrap (oracle port)", () => {
  let certDir;

  beforeEach(() => {
    clearPostgresEnv();
    certDir = mkdtempSync(join(tmpdir(), "oracle-pg-test-"));
  });

  afterEach(() => {
    clearPostgresEnv();
  });

  it("throws when a required base key is missing", () => {
    setBaseEnv();
    delete process.env.POSTGRES_HOST;
    expect(() => bootstrapPostgresFromEnv({ certDir })).to.throw(/POSTGRES_HOST is required/);
  });

  it("throws when a base key is whitespace-only", () => {
    setBaseEnv();
    process.env.POSTGRES_USER = "   ";
    expect(() => bootstrapPostgresFromEnv({ certDir })).to.throw(/POSTGRES_USER is required/);
  });

  it("stamps POSTGRES_URL with encoded credentials and libpq ssl params from inline PEMs", () => {
    setBaseEnv();
    process.env.POSTGRES_CLIENT_CERT = PEM_STUB;
    process.env.POSTGRES_CLIENT_KEY = KEY_STUB;
    process.env.POSTGRES_SERVER_CA_CERT = PEM_STUB;

    bootstrapPostgresFromEnv({ certDir });

    const url = new URL(process.env.POSTGRES_URL);
    expect(url.protocol).to.equal("postgresql:");
    expect(url.username).to.equal("senseai");
    expect(decodeURIComponent(url.password)).to.equal("p@ss word");
    expect(url.searchParams.get("sslmode")).to.equal("verify-ca");
    expect(url.searchParams.get("uselibpqcompat")).to.equal("true");
    expect(existsSync(url.searchParams.get("sslcert"))).to.equal(true);
    expect(existsSync(url.searchParams.get("sslkey"))).to.equal(true);
    expect(existsSync(url.searchParams.get("sslrootcert"))).to.equal(true);
  });

  it("base64-decodes inline PEMs (ROFL secret transport format)", () => {
    setBaseEnv();
    process.env.POSTGRES_CLIENT_CERT = Buffer.from(PEM_STUB).toString("base64");
    process.env.POSTGRES_CLIENT_KEY = Buffer.from(KEY_STUB).toString("base64");
    process.env.POSTGRES_SERVER_CA_CERT = Buffer.from(PEM_STUB).toString("base64");

    bootstrapPostgresFromEnv({ certDir });

    const url = new URL(process.env.POSTGRES_URL);
    const written = readFileSync(url.searchParams.get("sslcert"), "utf8");
    expect(written).to.include("-----BEGIN CERTIFICATE-----");
  });

  it("rejects a *_PATH that is not a regular file (directory misconfiguration)", () => {
    setBaseEnv();
    process.env.POSTGRES_CLIENT_CERT = PEM_STUB;
    process.env.POSTGRES_CLIENT_KEY_PATH = certDir; // a directory, not a key file
    process.env.POSTGRES_SERVER_CA_CERT = PEM_STUB;

    expect(() => bootstrapPostgresFromEnv({ certDir })).to.throw(/regular file/);
  });

  it("prefers *_PATH file sources over inline PEM and rejects group-readable keys", () => {
    setBaseEnv();
    const keyPath = join(certDir, "loose.key");
    writeFileSync(keyPath, KEY_STUB, { mode: 0o644 });
    process.env.POSTGRES_CLIENT_CERT = PEM_STUB;
    process.env.POSTGRES_CLIENT_KEY_PATH = keyPath;
    process.env.POSTGRES_SERVER_CA_CERT = PEM_STUB;

    expect(() => bootstrapPostgresFromEnv({ certDir })).to.throw(/0600/);
  });
});
