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
