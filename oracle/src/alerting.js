const { WebClient } = require("@slack/web-api");

/**
 * Sends a formatted alert message to a specified Slack channel.
 * @param {string} title The title of the alert.
 * @param {string} message The detailed alert message.
 */
async function sendSlackAlert(title, message) {
  const token = process.env.SLACK_ACCESS_TOKEN;
  const channel = process.env.SLACK_ALERT_CHANNEL;

  if (!token || !channel) {
    console.warn("Slack environment variables not set. Skipping Slack alert.");
    return;
  }

  try {
    const slack = new WebClient(token);
    const text = `🚨 *${title}* 🚨\n\n${message}\n\n*Timestamp:* ${new Date().toISOString()}`;
    await slack.chat.postMessage({ channel, text });
    console.log("Successfully sent Slack alert.");
  } catch (error) {
    console.error("Failed to send Slack alert:", error.message);
  }
}

/**
 * Whether email alerts should fire in the current environment.
 *
 * Email alerts land in a human inbox (admin@tradable.app), so they are
 * MAINNET-ONLY by default — localnet (including e2e) and testnet must never spam
 * it. `ALERT_EMAIL_ENABLED` is an explicit override: "true" forces email on (e.g.
 * to test email-alert functionality on a non-mainnet network), "false" forces it
 * off (e.g. to silence a noisy mainnet incident). Defaulting ON for mainnet —
 * rather than requiring a flag to be set — means a missing/forgotten flag can
 * never silently disable production alerting. Slack alerts are unaffected (they go
 * to a channel, not a personal inbox, and are already env-gated by their tokens).
 * @returns {boolean}
 */
function isEmailAlertingEnabled() {
  const override = process.env.ALERT_EMAIL_ENABLED;
  if (override === "true") return true;
  if (override === "false") return false;
  const network = process.env.NETWORK_NAME || "";
  return network === "sapphire" || network === "mainnet" || network.endsWith("-mainnet");
}

/**
 * Sends a formatted alert email via SendGrid.
 * @param {string} title The title of the alert.
 * @param {string} message The detailed alert message.
 */
async function sendEmailAlert(title, message) {
  // Email is mainnet-only by default (see isEmailAlertingEnabled). Return silently
  // on non-mainnet rather than logging per call: this path is hit on exactly the
  // high-frequency noise the gate exists to suppress (reorg/nonce alerts during
  // e2e/testnet), and the alert itself is already surfaced by the console.error in
  // sendAlert — so a per-call "skipping" line would just re-flood the logs.
  if (!isEmailAlertingEnabled()) {
    return;
  }

  const apiKey = process.env.SEND_GRID_API_KEY;
  const templateId = process.env.SEND_GRID_ALERT_TEMPLATE_ID;
  const fromEmail = process.env.ALERT_FROM_EMAIL;
  const fromName = process.env.ALERT_FROM_NAME || "Oracle Alert";
  const toEmail = process.env.ALERT_TO_EMAIL;

  if (!apiKey || !templateId || !fromEmail || !toEmail) {
    console.warn("SendGrid environment variables not set. Skipping email alert.");
    return;
  }

  const body = {
    personalizations: [
      {
        to: [{ email: toEmail }],
        dynamic_template_data: {
          alert_title: title,
          alert_message: message.replace(/\n/g, "<br>"),
          timestamp: new Date().toISOString(),
        },
      },
    ],
    from: { email: fromEmail, name: fromName },
    template_id: templateId,
  };

  try {
    const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`SendGrid API responded with status ${response.status}: ${errorBody}`);
    }
    console.log("Successfully sent email alert.");
  } catch (error) {
    console.error("Failed to send email alert:", error.message);
  }
}

/**
 * Sends a critical alert to all configured channels (Slack, Email).
 * @param {string} title The title of the alert.
 * @param {string} message The detailed alert message.
 */
async function sendAlert(title, message) {
  console.error(`🚨 ALERT: ${title} - ${message}`);
  // Run both in parallel and don't let one failure stop the other.
  await Promise.all([sendSlackAlert(title, message), sendEmailAlert(title, message)]);
}

module.exports = { sendAlert };
