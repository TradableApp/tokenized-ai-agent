const hre = require("hardhat");
const { Wallet } = require("ethers");
require("dotenv").config({ path: process.env.ENV_FILE || ".env" });

async function main() {
  console.log("Deploying ChatBot.sol...");

  const domain = process.env.DOMAIN || "example.com";
  const roflAppID = hre.ethers.zeroPadBytes("0x", 21);

  const wallet = new Wallet(process.env.PRIVATE_KEY);
  const oracle = wallet.address;

  console.log("Oracle address:", oracle);
  console.log("Domain:", domain);

  const ChatBot = await hre.ethers.getContractFactory("ChatBot");
  const chatBot = await ChatBot.deploy(domain, roflAppID, oracle);
  await chatBot.waitForDeployment();

  console.log("ChatBot deployed to:", await chatBot.getAddress());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
