const { expect } = require("chai");

const { createAlertThrottle } = require("../src/alertThrottle");

describe("alert throttle", () => {
  const TEN_MINUTES = 10 * 60 * 1000;

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
