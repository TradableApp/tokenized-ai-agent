const { expect } = require("chai");

// A store outage must be loud exactly once. The oracle absorbs a failed cursor write or a failed
// queue read so it can keep answering prompts — which also means it keeps looking healthy. The
// tracker is what turns "has been failing for a while" into one alert, and the end of the
// failure into one recovery line, instead of either silence or an alert every few seconds.

const MINUTE = 60 * 1000;

function setup(options = {}) {
  const { createOutageTracker } = require("../src/oracleState/outageTracker");
  const clock = { ms: 1_000_000 };
  const alerts = [];
  const recoveries = [];
  const tracker = createOutageTracker({
    alertAfterMs: 5 * MINUTE,
    now: () => clock.ms,
    onAlert: (error, info) => alerts.push({ error, ...info }),
    onRecover: (info) => recoveries.push(info),
    ...options,
  });
  return { tracker, clock, alerts, recoveries };
}

describe("outage tracker", () => {
  it("stays quiet for a failure shorter than the threshold", () => {
    const { tracker, clock, alerts } = setup();

    tracker.failure(new Error("blip"));
    clock.ms += 4 * MINUTE;
    tracker.failure(new Error("blip"));

    expect(alerts).to.deep.equal([]);
  });

  it("alerts once when failures have lasted past the threshold", () => {
    const { tracker, clock, alerts } = setup();
    const last = new Error("still down");

    tracker.failure(new Error("down"));
    clock.ms += 5 * MINUTE;
    tracker.failure(last);
    clock.ms += 30 * MINUTE;
    tracker.failure(new Error("and still"));

    expect(alerts).to.have.length(1);
    expect(alerts[0].error).to.equal(last);
    expect(alerts[0].failingForMs).to.equal(5 * MINUTE);
    expect(alerts[0].failures).to.equal(2);
  });

  it("reports recovery, saying whether the outage had been alerted", () => {
    const { tracker, clock, recoveries } = setup();

    tracker.failure(new Error("down"));
    clock.ms += 6 * MINUTE;
    tracker.failure(new Error("down"));
    clock.ms += MINUTE;
    tracker.success();

    expect(recoveries).to.deep.equal([{ failedForMs: 7 * MINUTE, failures: 2, alerted: true }]);
  });

  it("says nothing on a success that follows no failure", () => {
    const { tracker, recoveries } = setup();

    tracker.success();
    tracker.success();

    expect(recoveries).to.deep.equal([]);
  });

  it("starts a fresh outage after a recovery", () => {
    const { tracker, clock, alerts } = setup();

    tracker.failure(new Error("first"));
    clock.ms += 6 * MINUTE;
    tracker.failure(new Error("first"));
    tracker.success();
    tracker.failure(new Error("second"));
    clock.ms += MINUTE;
    tracker.failure(new Error("second"));

    expect(alerts).to.have.length(1);
  });

  it("does not let a throwing alert hook escape into the caller", () => {
    const { tracker, clock } = setup({
      onAlert: () => {
        throw new Error("alerting is down too");
      },
    });

    tracker.failure(new Error("down"));
    clock.ms += 6 * MINUTE;

    expect(() => tracker.failure(new Error("down"))).to.not.throw();
  });
});
