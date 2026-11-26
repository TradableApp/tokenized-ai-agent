const { expect } = require("chai");
const sinon = require("sinon");
const { performance } = require("node:perf_hooks");

const { UNREADABLE, createPromptReadTally } = require("../src/promptReadTally");

describe("prompt read tally", () => {
  const HOUR = 60 * 60 * 1000;

  function tallyAt(start = 1_000_000) {
    const clock = { ms: start };
    const tally = createPromptReadTally({ intervalMs: HOUR, now: () => clock.ms });
    return { clock, tally };
  }

  it("has a kind for each way a prompt can fail to be read", () => {
    expect(Object.values(UNREADABLE)).to.have.members([
      "wrap-not-opened",
      "key-wrong-length",
      "payload-not-utf8",
      "no-key",
    ]);
  });

  it("gives no notice while every prompt is read", () => {
    const { tally } = tallyAt();
    tally.noteRead();
    tally.noteRead();

    expect(tally.takeNotice()).to.equal(null);
  });

  it("gives a plain notice with the counts by kind and the number read", () => {
    const { tally } = tallyAt();
    tally.noteRead();
    tally.noteRead();
    tally.noteUnreadable(UNREADABLE.wrapNotOpened);
    tally.noteUnreadable(UNREADABLE.wrapNotOpened);
    tally.noteUnreadable(UNREADABLE.payloadNotUtf8);

    const notice = tally.takeNotice();

    expect(notice.title).to.not.match(/^CRITICAL/);
    expect(notice.message).to.include("Prompts read since the last notice: 2");
    expect(notice.message).to.include("Prompts that could not be read: 3");
    expect(notice.message).to.match(/did not open: 2/);
    expect(notice.message).to.match(/not UTF-8 text: 1/);
    expect(notice.message).to.match(/not 32 bytes: 0/);
    expect(notice.message).to.match(/none stored: 0/);
  });

  it("says a single unreadable prompt is a sender's mistake, and what to check when none is read", () => {
    const { tally } = tallyAt();
    tally.noteUnreadable(UNREADABLE.noKey);

    const { message } = tally.takeNotice();

    expect(message).to.match(/sender's mistake/);
    expect(message).to.match(/oracle public key/);
    expect(message).to.match(/dApp build/);
  });

  it("is CRITICAL when none was read and three or more could not be", () => {
    const { tally } = tallyAt();
    for (let i = 0; i < 3; i += 1) tally.noteUnreadable(UNREADABLE.wrapNotOpened);

    expect(tally.takeNotice().title).to.match(/^CRITICAL: /);
  });

  it("is not CRITICAL with two unreadable and none read, or with three unreadable and one read", () => {
    const two = tallyAt().tally;
    two.noteUnreadable(UNREADABLE.wrapNotOpened);
    two.noteUnreadable(UNREADABLE.wrapNotOpened);
    expect(two.takeNotice().title).to.not.match(/^CRITICAL/);

    const oneRead = tallyAt().tally;
    oneRead.noteRead();
    for (let i = 0; i < 3; i += 1) oneRead.noteUnreadable(UNREADABLE.keyWrongLength);
    expect(oneRead.takeNotice().title).to.not.match(/^CRITICAL/);
  });

  it("gives at most one notice an hour, and counts afresh after each", () => {
    const { clock, tally } = tallyAt();
    tally.noteUnreadable(UNREADABLE.wrapNotOpened);
    expect(tally.takeNotice(), "the first").to.not.equal(null);

    tally.noteUnreadable(UNREADABLE.wrapNotOpened);
    clock.ms += HOUR - 1;
    expect(tally.takeNotice(), "inside the hour").to.equal(null);

    clock.ms += 1;
    tally.noteRead();
    const second = tally.takeNotice();
    expect(second, "after the hour").to.not.equal(null);
    expect(second.message).to.include("Prompts that could not be read: 1");
    expect(second.message).to.include("Prompts read since the last notice: 1");
    expect(tally.takeNotice(), "nothing new").to.equal(null);
  });

  it("does not use up the hour when there is nothing to say", () => {
    const { tally } = tallyAt();
    tally.noteRead();
    expect(tally.takeNotice()).to.equal(null);

    tally.noteUnreadable(UNREADABLE.noKey);
    expect(tally.takeNotice()).to.not.equal(null);
  });

  it("ignores a kind it does not know", () => {
    const { tally } = tallyAt();
    tally.noteUnreadable("something-else");

    expect(tally.takeNotice()).to.equal(null);
  });

  it("carries nothing but its own words and the counts", () => {
    const { tally } = tallyAt();
    tally.noteUnreadable(UNREADABLE.wrapNotOpened);

    const { title, message } = tally.takeNotice();

    expect(`${title}\n${message}`).to.not.match(/0x[0-9a-f]{4,}|https?:\/\//i);
  });

  describe("its default clock", () => {
    afterEach(() => sinon.restore());

    it("follows the monotonic clock, not the wall clock", () => {
      let monotonic = 5_000;
      sinon.stub(performance, "now").callsFake(() => monotonic);
      let wall = Date.UTC(2026, 0, 2);
      sinon.stub(Date, "now").callsFake(() => wall);
      const tally = createPromptReadTally({ intervalMs: HOUR });

      tally.noteUnreadable(UNREADABLE.wrapNotOpened);
      expect(tally.takeNotice(), "first").to.not.equal(null);
      wall -= 24 * HOUR;
      monotonic += HOUR;
      tally.noteUnreadable(UNREADABLE.wrapNotOpened);
      expect(tally.takeNotice(), "an hour on").to.not.equal(null);
    });
  });
});
