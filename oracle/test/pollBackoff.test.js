const { expect } = require("chai");

const { createPollBackoff, retryAfterMs } = require("../src/pollBackoff");

describe("pollBackoff — the wait between polls grows on failure and comes back in steps", () => {
  const backoff = () => createPollBackoff({ baseMs: 4000, capMs: 60000 });

  it("waits the base interval while polls succeed", () => {
    const b = backoff();

    expect(b.success()).to.equal(4000);
    expect(b.success()).to.equal(4000);
  });

  it("doubles on each failure in a row", () => {
    const b = backoff();

    // 4000 * 2, * 2 again, * 2 again.
    expect(b.failure(new Error("rpc"))).to.equal(8000);
    expect(b.failure(new Error("rpc"))).to.equal(16000);
    expect(b.failure(new Error("rpc"))).to.equal(32000);
  });

  it("never waits longer than the cap", () => {
    const b = backoff();

    // 8000, 16000, 32000, then 64000 is over the 60000 cap.
    for (let i = 0; i < 3; i++) b.failure(new Error("rpc"));

    expect(b.failure(new Error("rpc"))).to.equal(60000);
    expect(b.failure(new Error("rpc"))).to.equal(60000);
  });

  it("recovers gradually: each success removes half of what is above the base", () => {
    const b = backoff();
    b.failure(new Error("rpc")); // 8000
    b.failure(new Error("rpc")); // 16000
    b.failure(new Error("rpc")); // 32000

    // 4000 + (32000 - 4000) / 2 = 18000; then 4000 + 14000 / 2 = 11000; then 7500; 5750.
    expect(b.success()).to.equal(18000);
    expect(b.success()).to.equal(11000);
    expect(b.success()).to.equal(7500);
    expect(b.success()).to.equal(5750);
  });

  it("settles back on the base exactly, not just above it for ever", () => {
    const b = backoff();
    b.failure(new Error("rpc")); // 8000

    let last = 0;
    for (let i = 0; i < 20; i++) last = b.success();

    expect(last).to.equal(4000);
  });

  it("a failure during recovery doubles from where the wait has got to", () => {
    const b = backoff();
    b.failure(new Error("rpc")); // 8000
    b.failure(new Error("rpc")); // 16000
    b.success(); // 4000 + 12000 / 2 = 10000

    expect(b.failure(new Error("rpc"))).to.equal(20000);
  });

  it("waits at least as long as the provider asks in Retry-After", () => {
    const b = backoff();
    const limited = Object.assign(new Error("429"), {
      info: { response: { statusCode: 429, headers: { "retry-after": "30" } } },
    });

    // The doubled wait would be 8000; the provider asked for 30 s.
    expect(b.failure(limited)).to.equal(30000);
  });

  it("holds a Retry-After to the cap as well", () => {
    const b = backoff();
    const limited = Object.assign(new Error("429"), {
      info: { response: { statusCode: 429, headers: { "retry-after": "600" } } },
    });

    expect(b.failure(limited)).to.equal(60000);
  });

  it("reports the wait it is on without changing it", () => {
    const b = backoff();
    b.failure(new Error("rpc"));

    expect(b.current()).to.equal(8000);
    expect(b.current()).to.equal(8000);
  });

  it("refuses a base that is not a positive number, or a cap below the base", () => {
    expect(() => createPollBackoff({ baseMs: 0, capMs: 60000 })).to.throw(/baseMs/);
    expect(() => createPollBackoff({ baseMs: NaN, capMs: 60000 })).to.throw(/baseMs/);
    expect(() => createPollBackoff({ baseMs: 4000, capMs: 1000 })).to.throw(/capMs/);
  });

  describe("retryAfterMs", () => {
    it("reads whole seconds from the response headers ethers attaches", () => {
      const error = { info: { response: { headers: { "retry-after": "7" } } } };

      expect(retryAfterMs(error)).to.equal(7000);
    });

    it("is 0 when there is no header, no response, or no error", () => {
      expect(retryAfterMs(new Error("plain"))).to.equal(0);
      expect(retryAfterMs({ info: { response: { headers: {} } } })).to.equal(0);
      expect(retryAfterMs(undefined)).to.equal(0);
    });

    it("is 0 for a value that is not a positive number of seconds", () => {
      // The HTTP-date form is not worth parsing here: the doubled wait applies instead.
      for (const value of ["soon", "-5", "", "Wed, 21 Oct 2026 07:28:00 GMT"]) {
        expect(
          retryAfterMs({ info: { response: { headers: { "retry-after": value } } } }),
        ).to.equal(0);
      }
    });
  });
});
