const { expect } = require("chai");
const sinon = require("sinon");

const { createRoleGate } = require("../src/oracleRoleGate");

describe("oracleRoleGate — work waits while the oracle does not hold its role", () => {
  let checkRole;
  let onLost;
  let onRestored;
  let sleep;

  const gate = () => createRoleGate({ checkRole, onLost, onRestored, recheckMs: 30000, sleep });

  beforeEach(() => {
    checkRole = sinon.stub();
    onLost = sinon.stub();
    onRestored = sinon.stub();
    sleep = sinon.stub().resolves();
  });

  it("lets work through at once while the role is held, without asking the chain", async () => {
    const roleGate = gate();

    await roleGate.ready();

    expect(roleGate.isLost()).to.equal(false);
    expect(checkRole.called).to.equal(false);
  });

  it("reports a lost role once, however many submissions hit it", () => {
    const roleGate = gate();
    const error = new Error("UnauthorizedOracle");

    roleGate.markLost(error);
    roleGate.markLost(error);
    roleGate.markLost(error);

    expect(roleGate.isLost()).to.equal(true);
    sinon.assert.calledOnceWithExactly(onLost, error);
  });

  it("holds work until the role is granted, checking again after each interval", async () => {
    checkRole.onCall(0).resolves(false);
    checkRole.onCall(1).resolves(false);
    checkRole.onCall(2).resolves(true);
    const roleGate = gate();
    roleGate.markLost();

    await roleGate.ready();

    expect(checkRole.callCount).to.equal(3);
    // Two waits of the configured interval: one after each "still not granted".
    expect(sleep.args).to.deep.equal([[30000], [30000]]);
    expect(roleGate.isLost()).to.equal(false);
    sinon.assert.calledOnce(onRestored);
  });

  it("lets work through at once again after the role came back", async () => {
    checkRole.resolves(true);
    const roleGate = gate();
    roleGate.markLost();
    await roleGate.ready();
    checkRole.resetHistory();

    await roleGate.ready();

    expect(checkRole.called).to.equal(false);
  });

  it("keeps waiting when the check itself fails", async () => {
    checkRole.onCall(0).rejects(new Error("RPC unavailable"));
    checkRole.onCall(1).resolves(true);
    const roleGate = gate();
    roleGate.markLost();

    await roleGate.ready();

    expect(checkRole.callCount).to.equal(2);
    expect(roleGate.isLost()).to.equal(false);
  });

  it("shares one wait between everything that is held", async () => {
    let grant;
    checkRole.returns(
      new Promise((resolve) => {
        grant = resolve;
      }),
    );
    const roleGate = gate();
    roleGate.markLost();

    const waiting = [roleGate.ready(), roleGate.ready(), roleGate.ready()];
    grant(true);
    await Promise.all(waiting);

    expect(checkRole.callCount).to.equal(1);
    sinon.assert.calledOnce(onRestored);
  });

  it("reminds while the wait goes on, once per reminder period", async () => {
    let clock = 0;
    const onStillLost = sinon.stub();
    // Seven checks 30 s apart find no role (t = 0 … 180 s); the eighth finds it.
    for (let call = 0; call < 7; call++) checkRole.onCall(call).resolves(false);
    checkRole.onCall(7).resolves(true);
    sleep.callsFake(async (ms) => {
      clock += ms;
    });
    const roleGate = createRoleGate({
      checkRole,
      onLost,
      onRestored,
      onStillLost,
      recheckMs: 30000,
      remindEveryMs: 60000,
      sleep,
      now: () => clock,
    });
    roleGate.markLost();

    await roleGate.ready();

    // 210 s of waiting, a reminder each full 60 s: at 60, 120 and 180 s.
    expect(onStillLost.callCount).to.equal(3);
    expect(onStillLost.firstCall.args[0]).to.deep.equal({ waitingForMs: 60000 });
  });

  it("falls back to the default interval when given one that is not a positive number", async () => {
    checkRole.onCall(0).resolves(false);
    checkRole.onCall(1).resolves(true);
    const roleGate = createRoleGate({ checkRole, recheckMs: () => -5, sleep });
    roleGate.markLost();

    await roleGate.ready();

    expect(sleep.args).to.deep.equal([[30000]]);
  });

  it("starts a fresh wait after a reset, leaving a discarded one behind", async () => {
    let releaseOld;
    checkRole.onCall(0).returns(
      new Promise((resolve) => {
        releaseOld = resolve;
      }),
    );
    checkRole.onCall(1).resolves(true);
    const roleGate = gate();
    roleGate.markLost();
    const discarded = roleGate.ready();
    roleGate.reset();

    roleGate.markLost();
    await roleGate.ready();

    // The new wait asked for itself instead of joining the one that was still pending.
    expect(checkRole.callCount).to.equal(2);
    releaseOld(true);
    await discarded;
  });

  it("does not let a failing hook stop the oracle", async () => {
    onLost.throws(new Error("alerting down"));
    onRestored.rejects(new Error("alerting down"));
    checkRole.resolves(true);
    const roleGate = gate();

    roleGate.markLost();
    await roleGate.ready();

    expect(roleGate.isLost()).to.equal(false);
  });
});
