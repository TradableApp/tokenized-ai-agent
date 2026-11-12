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
 * A stored enum is kept as a number, so the order of its values is part of the layout too: a
 * value inserted or moved changes what every stored number means. Enum values are pinned from
 * the compiler's syntax tree and must only ever be appended.
 *
 * Types are pinned by the compiler's own labels (`contract IERC20`, `struct X.Y`), so renaming a
 * contract, interface or struct also fails here; update the label if the rename is intended.
 * An entry is `[label, type]` for a variable that starts a slot, or `[label, type, offset]` for
 * one packed into the same slot as the entry before it.
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
    enums: {},
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
    enums: {
      EscrowStatus: ["PENDING", "COMPLETE", "REFUNDED"],
    },
  },
};

async function readLayout(fullyQualifiedName) {
  const [sourceName, contractName] = fullyQualifiedName.split(":");
  const buildInfo = await artifacts.getBuildInfo(fullyQualifiedName);
  return buildInfo.output.contracts[sourceName][contractName].storageLayout;
}

/** Every enum declared in the contract, with its values in declaration order. */
async function readEnums(fullyQualifiedName) {
  const [sourceName, contractName] = fullyQualifiedName.split(":");
  const buildInfo = await artifacts.getBuildInfo(fullyQualifiedName);
  const contract = buildInfo.output.sources[sourceName].ast.nodes.find(
    (node) => node.nodeType === "ContractDefinition" && node.name === contractName,
  );
  const enums = {};
  for (const node of contract.nodes) {
    if (node.nodeType === "EnumDefinition") {
      enums[node.name] = node.members.map((member) => member.name);
    }
  }
  return enums;
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

/** The pinned form of the same thing. An entry with an offset shares the slot before it. */
function expectedEntries(pinned) {
  let slot = -1;
  return pinned.map(([label, type, offset = 0]) => {
    if (offset === 0) {
      slot += 1;
    }
    return { label, slot: String(slot), offset, type };
  });
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

      it("keeps every enum's values in their declared order", async function () {
        const actual = await readEnums(fullyQualifiedName);

        expect(actual).to.deep.equal(expected.enums);
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
