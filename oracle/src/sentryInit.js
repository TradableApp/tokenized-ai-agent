const Sentry = require("@sentry/node");

const SENSITIVE_KEYS = [
  "AI_AGENT_PRIVATE_KEY",
  "AUTONOMYS_MNEMONIC",
  "IRYS_KEY",
  "privateKey",
  "mnemonic",
  "encryptedPayload",
  "roflEncryptedKey",
];

function scrubSensitiveData(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const result = Array.isArray(obj) ? [...obj] : { ...obj };
  for (const key of Object.keys(result)) {
    if (SENSITIVE_KEYS.some((s) => key.includes(s))) {
      result[key] = "[REDACTED]";
    } else if (typeof result[key] === "object") {
      result[key] = scrubSensitiveData(result[key]);
    }
  }
  return result;
}

function initSentry() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    console.log("[Sentry] SENTRY_DSN not set — error monitoring disabled.");
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || "production",
    tracesSampleRate: 0.1,
    beforeSend(event) {
      if (event.extra) event.extra = scrubSensitiveData(event.extra);
      if (event.contexts) event.contexts = scrubSensitiveData(event.contexts);
      if (event.request?.data) event.request.data = scrubSensitiveData(event.request.data);
      return event;
    },
  });

  console.log(
    `[Sentry] Initialized for environment: ${process.env.SENTRY_ENVIRONMENT || "production"}`,
  );
}

module.exports = { initSentry };
