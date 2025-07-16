const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();

  console.log("Deploying ChatBot.sol with account:", deployer.address);

  // Parameters for constructor
  const domain = "example.com"; // SIWE domain for authentication
  const roflAppID = hre.ethers.zeroPadValue("0x0", 21); // bytes21(0)
  const oracle = deployer.address; // In production, replace with actual Oracle signer address

  // Deploy contract
  const ChatBot = await hre.ethers.getContractFactory("ChatBot");
  const chatBot = await ChatBot.deploy(domain, roflAppID, oracle);
  await chatBot.waitForDeployment();

  console.log("ChatBot deployed to:", await chatBot.getAddress());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
