const { expect } = require("chai");
const { artifacts } = require("hardhat");

/**
 * The upgradeable contracts live behind proxies that already hold state. A variable inserted,
 * removed or reordered ahead of an existing one moves every later slot and corrupts that state on
 * upgrade, and nothing else in the suite would notice.
 *
 * These lists are the layout in slot order. A new variable is appended just before `__gap`, the
 * gap shrinks by the slots it takes, and the list here is extended to match. Any other edit to a
 * list is a layout break for the deployed proxies.
 */
const RESERVED_SLOTS = 50;

const EXPECTED_LAYOUTS = {
  "contracts/EVMAIAgent.sol:EVMAIAgent": [
    "oracle",
    "aiAgentEscrow",
    "domain",
    "conversationIdCounter",
    "messageIdCounter",
    "jobIdCounter",
    "triggerIdCounter",
    "conversationToOwner",
    "jobToOwner",
    "messageToConversation",
    "triggerToJob",
    "isJobFinalized",
    "isRegenerationPending",
    "_regenerationLockOf",
    "requestCount",
    "requestBlock",
    "__gap",
  ],
  "contracts/EVMAIAgentEscrow.sol:EVMAIAgentEscrow": [
    "ableToken",
    "evmAIAgent",
    "treasury",
    "promptFee",
    "cancellationFee",
    "metadataUpdateFee",
    "branchFee",
    "spendingLimits",
    "pendingEscrowCount",
    "escrows",
    "__gap",
  ],
};

async function readLayout(fullyQualifiedName) {
  const [sourceName, contractName] = fullyQualifiedName.split(":");
  const buildInfo = await artifacts.getBuildInfo(fullyQualifiedName);
  return buildInfo.output.contracts[sourceName][contractName].storageLayout;
}

describe("Storage layout of the upgradeable contracts", function () {
  for (const [fullyQualifiedName, expectedLabels] of Object.entries(EXPECTED_LAYOUTS)) {
    const contractName = fullyQualifiedName.split(":")[1];

    describe(contractName, function () {
      it("keeps every variable in its slot, one slot each, in the pinned order", async function () {
        const layout = await readLayout(fullyQualifiedName);

        const actual = layout.storage.map(({ label, slot, offset }) => ({ label, slot, offset }));

        const expected = expectedLabels.map((label, index) => ({
          label,
          slot: String(index),
          offset: 0,
        }));
        expect(actual).to.deep.equal(expected);
      });

      it("variables plus the gap fill exactly the reserved slots", async function () {
        const layout = await readLayout(fullyQualifiedName);
        const gap = layout.storage[layout.storage.length - 1];

        const gapSlots = Number(layout.types[gap.type].numberOfBytes) / 32;

        expect(gap.label).to.equal("__gap");
        expect(Number(gap.slot) + gapSlots).to.equal(RESERVED_SLOTS);
      });
    });
  }
});
