const { expect } = require("chai");
const { artifacts } = require("hardhat");

/**
 * The upgradeable contracts live behind proxies that already hold state. A variable inserted,
 * removed, reordered or retyped ahead of or in place of an existing one, or a field moved inside
 * a stored struct, corrupts that state on upgrade, and nothing else in the suite would notice.
 *
 * These lists are the layout in slot order, each variable with its type. A new variable is
 * appended just before `__gap`, the gap shrinks by the slots it takes, and the list here is
 * extended to match. A new struct field is appended to the end of its struct. Any other edit to
 * these lists is a layout break for the deployed proxies.
 *
 * The compiler's layout does not carry the order of an enum's values, so `EscrowStatus` is not
 * covered here: its values must only ever be appended.
 */
const RESERVED_SLOTS = 50;

const EXPECTED_LAYOUTS = {
  "contracts/EVMAIAgent.sol:EVMAIAgent": {
    storage: [
      ["oracle", "address"],
      ["aiAgentEscrow", "contract IEVMAIAgentEscrow"],
      ["domain", "string"],
      ["conversationIdCounter", "uint256"],
      ["messageIdCounter", "uint256"],
      ["jobIdCounter", "uint256"],
      ["triggerIdCounter", "uint256"],
      ["conversationToOwner", "mapping(uint256 => address)"],
      ["jobToOwner", "mapping(uint256 => address)"],
      ["messageToConversation", "mapping(uint256 => uint256)"],
      ["triggerToJob", "mapping(uint256 => uint256)"],
      ["isJobFinalized", "mapping(uint256 => bool)"],
      ["isRegenerationPending", "mapping(uint256 => bool)"],
      ["_regenerationLockOf", "mapping(uint256 => uint256)"],
      ["requestCount", "uint256"],
      ["requestBlock", "mapping(uint256 => uint256)"],
      ["__gap", "uint256[34]"],
    ],
    structs: {},
  },
  "contracts/EVMAIAgentEscrow.sol:EVMAIAgentEscrow": {
    storage: [
      ["ableToken", "contract IERC20"],
      ["evmAIAgent", "contract IEVMAIAgent"],
      ["treasury", "address"],
      ["promptFee", "uint256"],
      ["cancellationFee", "uint256"],
      ["metadataUpdateFee", "uint256"],
      ["branchFee", "uint256"],
      ["spendingLimits", "mapping(address => struct EVMAIAgentEscrow.SpendingLimit)"],
      ["pendingEscrowCount", "mapping(address => uint256)"],
      ["escrows", "mapping(uint256 => struct EVMAIAgentEscrow.Escrow)"],
      ["__gap", "uint256[40]"],
    ],
    structs: {
      "struct EVMAIAgentEscrow.SpendingLimit": [
        ["allowance", "uint256"],
        ["spentAmount", "uint256"],
        ["expiresAt", "uint256"],
      ],
      "struct EVMAIAgentEscrow.Escrow": [
        ["user", "address"],
        ["amount", "uint256"],
        ["createdAt", "uint256"],
        ["status", "enum EVMAIAgentEscrow.EscrowStatus"],
      ],
    },
  },
};

async function readLayout(fullyQualifiedName) {
  const [sourceName, contractName] = fullyQualifiedName.split(":");
  const buildInfo = await artifacts.getBuildInfo(fullyQualifiedName);
  return buildInfo.output.contracts[sourceName][contractName].storageLayout;
}

/** One entry per variable or struct field: where it sits and what type the compiler gave it. */
function describeEntries(entries, types) {
  return entries.map(({ label, slot, offset, type }) => ({
    label,
    slot,
    offset,
    type: types[type].label,
  }));
}

/** The pinned form of the same thing: every entry fills one whole slot, in list order. */
function expectedEntries(pairs) {
  return pairs.map(([label, type], index) => ({ label, slot: String(index), offset: 0, type }));
}

describe("Storage layout of the upgradeable contracts", function () {
  for (const [fullyQualifiedName, expected] of Object.entries(EXPECTED_LAYOUTS)) {
    const contractName = fullyQualifiedName.split(":")[1];

    describe(contractName, function () {
      it("keeps every variable in its slot with its type, in the pinned order", async function () {
        const layout = await readLayout(fullyQualifiedName);

        const actual = describeEntries(layout.storage, layout.types);

        expect(actual).to.deep.equal(expectedEntries(expected.storage));
      });

      it("keeps every field of every stored struct in its slot with its type", async function () {
        const layout = await readLayout(fullyQualifiedName);

        const actual = {};
        for (const type of Object.values(layout.types)) {
          if (type.members) {
            actual[type.label] = describeEntries(type.members, layout.types);
          }
        }

        const pinned = {};
        for (const [label, pairs] of Object.entries(expected.structs)) {
          pinned[label] = expectedEntries(pairs);
        }
        expect(actual).to.deep.equal(pinned);
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
