const { expect } = require("chai");

const {
  createThoughtDropAlerter,
  THOUGHT_DROP_ALERT_KINDS,
  THOUGHT_DROP_ALERT_REPEAT_MS,
} = require("../src/stream/thoughtDropAlert");

// A thought the oracle cannot sanitise is dropped from the stream and from storage. That keeps
// the answer safe but leaves it without reasoning, and nobody would know: the alert says so, by
// kind only, once, and again at most once an hour while it goes on.

function harness() {
  const sent = [];
  let clock = 1_000_000;
  const notify = createThoughtDropAlerter({
    alert: async (title, message) => {
      sent.push({ title, message });
    },
    now: () => clock,
  });
  return {
    sent,
    notify,
    advance: (ms) => {
      clock += ms;
    },
  };
}

describe("thought drop alert", () => {
  it("alerts on the first drop of a failing kind, then not again within the hour", () => {
    const { sent, notify, advance } = harness();

    notify("unavailable");
    notify("unavailable");
    advance(THOUGHT_DROP_ALERT_REPEAT_MS - 1);
    notify("unavailable");

    expect(sent).to.have.length(1);
    expect(sent[0].message).to.include("unavailable");
  });

  it("alerts again once an hour has passed while the drops go on", () => {
    const { sent, notify, advance } = harness();

    notify("timeout");
    advance(THOUGHT_DROP_ALERT_REPEAT_MS);
    notify("timeout");

    expect(THOUGHT_DROP_ALERT_REPEAT_MS).to.equal(60 * 60 * 1000);
    expect(sent).to.have.length(2);
  });

  it("keeps each kind's hour apart", () => {
    const { sent, notify } = harness();

    notify("timeout");
    notify("late");
    notify("failed");

    expect(sent.map((s) => s.message.match(/kind: ([a-z]+)/)[1])).to.deep.equal([
      "timeout",
      "late",
      "failed",
    ]);
  });

  it("does not alert for a thought the Brain refused, which is the sanitiser working", () => {
    const { sent, notify } = harness();

    notify("refused");

    expect(THOUGHT_DROP_ALERT_KINDS).to.not.include("refused");
    expect(THOUGHT_DROP_ALERT_KINDS).to.have.members(["unavailable", "timeout", "failed", "late"]);
    expect(sent).to.have.length(0);
  });

  it("ignores a kind it does not know", () => {
    const { sent, notify } = harness();

    notify("whatever");
    notify(undefined);

    expect(sent).to.have.length(0);
  });

  it("says the answer is not affected and where the counts are, and carries no id, url or text", () => {
    const { sent, notify } = harness();

    notify("unavailable");

    const { title, message } = sent[0];
    expect(title).to.match(/thoughts/i);
    expect(message).to.match(/answers are not affected/i);
    expect(message).to.include("stream.thoughtsDropped");
    expect(`${title} ${message}`).to.not.match(/https?:|0x[0-9a-f]{8}/i);
  });

  it("never throws or rejects when the alert fails", async () => {
    const throwing = createThoughtDropAlerter({
      alert: () => {
        throw new Error("slack down");
      },
    });
    const rejecting = createThoughtDropAlerter({
      alert: () => Promise.reject(new Error("slack down")),
    });
    const originalError = console.error;
    console.error = () => {};
    try {
      expect(() => throwing("timeout")).to.not.throw();
      expect(() => rejecting("timeout")).to.not.throw();
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      console.error = originalError;
    }
  });
});
