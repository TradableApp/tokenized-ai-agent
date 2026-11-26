const { expect } = require("chai");
const sinon = require("sinon");
const { performance } = require("node:perf_hooks");

const { createAlertThrottle } = require("../src/alertThrottle");

describe("alert throttle", () => {
  const TEN_MINUTES = 10 * 60 * 1000;

  describe("its default clock", () => {
    afterEach(() => sinon.restore());

    // The wall clock can be set back (an NTP step, an operator); a throttle on it would then hold
    // every alert for as long as the clock was moved. The default reads a clock that only goes on.
    it("follows the monotonic clock, not the wall clock", () => {
      let monotonic = 5_000;
      sinon.stub(performance, "now").callsFake(() => monotonic);
      let wall = Date.UTC(2026, 0, 2);
      sinon.stub(Date, "now").callsFake(() => wall);
      const throttle = createAlertThrottle({ intervalMs: TEN_MINUTES });

      expect(throttle.shouldSend(), "first").to.equal(true);
      wall -= 24 * 60 * 60 * 1000; // the wall clock is set back a day
      monotonic += TEN_MINUTES - 1;
      expect(throttle.shouldSend(), "inside the interval").to.equal(false);
      monotonic += 1;
      expect(throttle.shouldSend(), "once the interval has passed").to.equal(true);
    });
  });

  function throttleAt(start) {
    const clock = { ms: start };
    const throttle = createAlertThrottle({ intervalMs: TEN_MINUTES, now: () => clock.ms });
    return { clock, throttle };
  }

  it("lets the first alert through", () => {
    const { throttle } = throttleAt(1_000_000);

    expect(throttle.shouldSend()).to.equal(true);
  });

  it("holds every repeat inside the interval", () => {
    const { clock, throttle } = throttleAt(1_000_000);
    throttle.shouldSend();

    clock.ms += 1;
    expect(throttle.shouldSend()).to.equal(false);
    clock.ms += TEN_MINUTES - 2;
    expect(throttle.shouldSend()).to.equal(false);
  });

  it("lets one through again once the interval has passed since the last one sent", () => {
    const { clock, throttle } = throttleAt(1_000_000);
    throttle.shouldSend();

    clock.ms += TEN_MINUTES;
    expect(throttle.shouldSend()).to.equal(true);
    clock.ms += TEN_MINUTES - 1;
    expect(throttle.shouldSend()).to.equal(false);
  });

  it("lets the first alert through on a clock that starts at zero", () => {
    const { throttle } = throttleAt(0);

    expect(throttle.shouldSend()).to.equal(true);
  });
});
