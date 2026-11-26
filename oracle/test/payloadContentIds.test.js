"use strict";

// A content id in a payload is chosen by the user, inside their encrypted payload, and the oracle
// fetches what it names. It must have the shape of an id the storage paths produce before
// anything reads it, and a refusal must never repeat it.

const { expect } = require("chai");

const { validatePayload } = require("../src/payloadValidator");
const { isBadInputError } = require("../src/errors");

const AUTONOMYS_ID = `bafkr6i${"abcdefghijklmnopqrstuvwxyz234567".repeat(2).slice(0, 52)}`;
const ARWEAVE_ID = "Ab0_-".repeat(9).slice(0, 43);
const MOCK_ID = "mock_0123456789abcdef0123";
const LOCAL_IPFS_RAW_ID = `bafkrei${"a".repeat(52)}`;
const LOCAL_IPFS_DAG_ID = `bafybei${"a".repeat(52)}`;
// The dApp's rule for a content id it reads (an answer frame's id): 1 to 128 of these.
const DAPP_CONTENT_ID = /^[A-Za-z0-9_-]{1,128}$/;

const FORGED_LINES = `${"x".repeat(50)}\n[Oracle] forged line\n${"y".repeat(100000)}`;

const REFUSED = [
  ["a forged log line of 100,000 characters", FORGED_LINES],
  ["a free string", "fake_cid_prev_answer"],
  ["an empty string", ""],
  ["an Autonomys id one short", `bafkr6i${"a".repeat(51)}`],
  ["an Autonomys id one long", `bafkr6i${"a".repeat(53)}`],
  ["an Autonomys id in upper case", `BAFKR6I${"A".repeat(52)}`],
  ["an Autonomys id with a base32 digit it lacks", `bafkr6i${"1".repeat(52)}`],
  ["an Arweave id of 42", "A".repeat(42)],
  ["an Arweave id of 45", "A".repeat(45)],
  ["an Arweave id with a slash", `${"A".repeat(42)}/`],
  ["an Arweave id with a dot", `${"A".repeat(42)}.`],
  ["a URL", "https://example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
  ["an id with a trailing newline", `${ARWEAVE_ID}\n`],
  ["a number", 12345],
];

function refusalOf(input, eventName) {
  try {
    validatePayload(input, eventName);
  } catch (error) {
    return error;
  }
  throw new Error("expected the payload to be refused");
}

function prompt(previousMessageCID) {
  return { promptText: "hello", isNewConversation: false, previousMessageCID };
}

function regeneration(fields) {
  return {
    instructions: "shorter",
    promptMessageCID: AUTONOMYS_ID,
    originalAnswerMessageCID: AUTONOMYS_ID,
    ...fields,
  };
}

describe("payload content ids", () => {
  let saved;

  beforeEach(() => {
    saved = {
      USE_MOCK_STORAGE: process.env.USE_MOCK_STORAGE,
      LOCAL_IPFS_API_URL: process.env.LOCAL_IPFS_API_URL,
    };
    process.env.USE_MOCK_STORAGE = "false";
    delete process.env.LOCAL_IPFS_API_URL;
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  describe("accepted", () => {
    it("an Autonomys id and an Arweave/Irys id, in every content id field", () => {
      for (const id of [AUTONOMYS_ID, ARWEAVE_ID, "B".repeat(44)]) {
        expect(validatePayload(prompt(id), "PromptSubmitted").previousMessageCID).to.equal(id);
        const parsed = validatePayload(
          regeneration({ promptMessageCID: id, originalAnswerMessageCID: id }),
          "RegenerationRequested",
        );
        expect(parsed.promptMessageCID).to.equal(id);
        expect(parsed.originalAnswerMessageCID).to.equal(id);
      }
    });

    it("no parent for a new conversation (null or absent)", () => {
      expect(validatePayload(prompt(null), "PromptSubmitted").previousMessageCID).to.equal(null);
      expect(
        validatePayload({ promptText: "hi", isNewConversation: true }, "PromptSubmitted"),
      ).to.not.have.property("previousMessageCID");
    });

    it("a mock id only with mock storage, a local IPFS id only with a local IPFS node", () => {
      expect(isBadInputError(refusalOf(prompt(MOCK_ID), "PromptSubmitted"))).to.equal(true);
      expect(isBadInputError(refusalOf(prompt(LOCAL_IPFS_RAW_ID), "PromptSubmitted"))).to.equal(
        true,
      );

      process.env.USE_MOCK_STORAGE = "true";
      expect(validatePayload(prompt(MOCK_ID), "PromptSubmitted").previousMessageCID).to.equal(
        MOCK_ID,
      );

      process.env.USE_MOCK_STORAGE = "false";
      process.env.LOCAL_IPFS_API_URL = "http://127.0.0.1:5001";
      for (const id of [LOCAL_IPFS_RAW_ID, LOCAL_IPFS_DAG_ID]) {
        expect(validatePayload(prompt(id), "PromptSubmitted").previousMessageCID).to.equal(id);
      }
    });

    it("every accepted shape is inside the dApp's rule for a content id", () => {
      for (const id of [AUTONOMYS_ID, ARWEAVE_ID, "B".repeat(44), MOCK_ID, LOCAL_IPFS_RAW_ID]) {
        expect(id).to.match(DAPP_CONTENT_ID);
      }
    });
  });

  describe("refused as bad input, never repeated", () => {
    for (const [label, value] of REFUSED) {
      it(`${label}: previousMessageCID`, () => {
        const error = refusalOf(prompt(value), "PromptSubmitted");

        expect(isBadInputError(error)).to.equal(true);
        expect(error.message).to.include("previousMessageCID");
        if (typeof value === "string" && value.length > 0) {
          expect(error.message).to.not.include(value);
        }
        expect(error.message).to.not.include("forged line");
        expect(error.message.length).to.be.below(300);
      });

      it(`${label}: promptMessageCID and originalAnswerMessageCID`, () => {
        for (const field of ["promptMessageCID", "originalAnswerMessageCID"]) {
          const error = refusalOf(regeneration({ [field]: value }), "RegenerationRequested");

          expect(isBadInputError(error)).to.equal(true);
          expect(error.message).to.include(field);
          expect(error.message).to.not.include("forged line");
        }
      });
    }
  });
});
