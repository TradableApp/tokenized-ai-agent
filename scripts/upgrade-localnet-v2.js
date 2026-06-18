/**
 * Upgrade a localnet EVM UUPS proxy (EVMAIAgent or EVMAIAgentEscrow) to its V2 test
 * implementation (contracts/test/*V2.sol), via the OpenZeppelin hardhat-upgrades plugin.
 *
 * Test-support tooling for the SenseAI e2e suite (sense-ai-dapp `T-GOV-UPGRADE`): it proves a
 * live UUPS upgrade preserves storage (spending limits / in-flight escrows) and the dApp keeps
 * working on the same proxy address. It is NOT a deployment script — it only runs against the
 * localnet node and requires the OZ upgrades manifest written by `deploy:base-localnet`
 * (`.openzeppelin/unknown-31337.json`).
 *
 * Run (proxy address + which contract are passed via env so the e2e can target the deployed proxy):
 *   PROXY_ADDRESS=0x... UPGRADE_TARGET=escrow bun run upgrade:base-localnet-v2
 *   PROXY_ADDRESS=0x... UPGRADE_TARGET=agent  bun run upgrade:base-localnet-v2
 *
 * The upgrade is owner-only; on localnet the deployer (account 0, from .env.base-localnet's
 * PRIVATE_KEY) is the owner, which is the default signer for the `localnet` network.
 */
const hre = require("hardhat");

async function main() {
  const proxy = process.env.PROXY_ADDRESS;
  if (!proxy) {
    throw new Error("PROXY_ADDRESS env var is required (the UUPS proxy address to upgrade).");
  }

  const target = (process.env.UPGRADE_TARGET || "escrow").toLowerCase();
  if (target !== "escrow" && target !== "agent") {
    throw new Error(`UPGRADE_TARGET must be "escrow" or "agent" (got "${target}").`);
  }
  const factoryName = target === "agent" ? "EVMAIAgentV2" : "EVMAIAgentEscrowV2";

  console.log(
    `Upgrading ${target} proxy ${proxy} → ${factoryName} (UUPS) on network "${hre.network.name}"…`,
  );

  const V2 = await hre.ethers.getContractFactory(factoryName);
  const upgraded = await hre.upgrades.upgradeProxy(proxy, V2, { kind: "uups" });
  await upgraded.waitForDeployment();

  const version = await upgraded.version();
  console.log(`✅ Upgraded ${target} proxy to ${factoryName}; version()=${version}`);
  if (version !== "2.0") {
    throw new Error(`Unexpected version after upgrade: "${version}" (expected "2.0").`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
