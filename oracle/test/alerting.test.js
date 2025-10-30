const chai = require("chai");
const sinon = require("sinon");
const { expect } = chai;
const proxyquire = require("proxyquire");

describe("alerting", function () {
  let sendAlert;
  let slackStub, fetchStub, consoleErrorStub, consoleWarnStub;

  beforeEach(() => {
    // Stub for the Slack WebClient
    slackStub = {
      chat: {
        postMessage: sinon.stub().resolves(),
      },
    };

    // Stub for node-fetch
    fetchStub = sinon.stub().resolves({ ok: true });

    // Stub console methods to check for logs
    consoleErrorStub = sinon.stub(console, "error");
    consoleWarnStub = sinon.stub(console, "warn");

    // Use proxyquire to inject our stubs
    const alertingModule = proxyquire("../src/alerting", {
      "@slack/web-api": {
        WebClient: sinon.stub().returns(slackStub),
      },
      "node-fetch": fetchStub,
    });
    sendAlert = alertingModule.sendAlert;
  });

  afterEach(() => {
    sinon.restore();
    // Clear environment variables after each test to ensure isolation
    delete process.env.SLACK_ACCESS_TOKEN;
    delete process.env.SEND_GRID_API_KEY;
  });

  it("should send both Slack and Email alerts when all env vars are set", async () => {
    process.env.SLACK_ACCESS_TOKEN = "fake-slack-token";
    process.env.SLACK_ALERT_CHANNEL = "#fake-channel";
    process.env.SEND_GRID_API_KEY = "fake-sendgrid-key";
    process.env.SEND_GRID_ALERT_TEMPLATE_ID = "d-123";
    process.env.ALERT_FROM_EMAIL = "from@test.com";
    process.env.ALERT_TO_EMAIL = "to@test.com";

    const title = "Test Title";
    const message = "This is a test message.";

    await sendAlert(title, message);

    // Verify Slack call
    expect(slackStub.chat.postMessage.calledOnce).to.be.true;
    const slackArgs = slackStub.chat.postMessage.firstCall.args[0];
    expect(slackArgs.channel).to.equal("#fake-channel");
    expect(slackArgs.text).to.include(`*${title}*`);
    expect(slackArgs.text).to.include(message);

    // Verify SendGrid call (via node-fetch)
    expect(fetchStub.calledOnce).to.be.true;
    const fetchArgs = fetchStub.firstCall.args;
    const body = JSON.parse(fetchArgs[1].body);
    expect(body.template_id).to.equal("d-123");
    expect(body.personalizations[0].dynamic_template_data.alert_title).to.equal(title);
    expect(body.personalizations[0].dynamic_template_data.alert_message).to.equal(
      message.replace(/\n/g, "<br>"),
    );
  });

  it("should only send an email alert if Slack vars are missing", async () => {
    // ONLY set SendGrid vars
    process.env.SEND_GRID_API_KEY = "fake-sendgrid-key";
    process.env.SEND_GRID_ALERT_TEMPLATE_ID = "d-123";
    process.env.ALERT_FROM_EMAIL = "from@test.com";
    process.env.ALERT_TO_EMAIL = "to@test.com";

    await sendAlert("Test", "Test");

    // Slack should NOT be called, but a warning should be logged
    expect(slackStub.chat.postMessage.called).to.be.false;
    expect(consoleWarnStub.calledWith("Slack environment variables not set. Skipping Slack alert."))
      .to.be.true;

    // Fetch (SendGrid) SHOULD be called
    expect(fetchStub.calledOnce).to.be.true;
  });

  it("should only send a Slack alert if SendGrid vars are missing", async () => {
    // ONLY set Slack vars
    process.env.SLACK_ACCESS_TOKEN = "fake-slack-token";
    process.env.SLACK_ALERT_CHANNEL = "#fake-channel";

    await sendAlert("Test", "Test");

    // Slack SHOULD be called
    expect(slackStub.chat.postMessage.calledOnce).to.be.true;

    // Fetch (SendGrid) should NOT be called, and a warning should be logged
    expect(fetchStub.called).to.be.false;
    expect(
      consoleWarnStub.calledWith("SendGrid environment variables not set. Skipping email alert."),
    ).to.be.true;
  });

  it("should log errors if an API call fails but not throw", async () => {
    process.env.SLACK_ACCESS_TOKEN = "fake-slack-token";
    process.env.SLACK_ALERT_CHANNEL = "#fake-channel";

    // Make the Slack API call fail
    slackStub.chat.postMessage.rejects(new Error("Slack API is down"));

    await sendAlert("Failure Test", "This should still run");

    // The console.error inside the alerting module should be called
    expect(consoleErrorStub.calledWith("Failed to send Slack alert:", "Slack API is down")).to.be
      .true;
  });
});
