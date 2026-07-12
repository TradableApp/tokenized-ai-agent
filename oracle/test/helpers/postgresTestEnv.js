// Shared Postgres env setup for the brainContext tests (unit + integration).
//
// Single source of truth for the env keys brainContext.js's isConfigured()
// requires (REQUIRED_KEYS + the client-cert / key / server-CA pair). Keeping it
// here means adding a new required key updates one place, not every test file.

function clearPostgresEnv() {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("POSTGRES_") || key === "BRAIN_CONTEXT_ENABLED") delete process.env[key];
  }
}

function setFullPostgresEnv() {
  process.env.POSTGRES_HOST = "10.0.0.5";
  process.env.POSTGRES_PORT = "5432";
  process.env.POSTGRES_DATABASE = "senseai";
  process.env.POSTGRES_USER = "senseai";
  process.env.POSTGRES_PASSWORD = "pw";
  process.env.POSTGRES_CLIENT_CERT = "-----BEGIN CERTIFICATE-----";
  process.env.POSTGRES_CLIENT_KEY = "-----BEGIN PRIVATE KEY-----";
  process.env.POSTGRES_SERVER_CA_CERT = "-----BEGIN CERTIFICATE-----";
}

module.exports = { clearPostgresEnv, setFullPostgresEnv };
