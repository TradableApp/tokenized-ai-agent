const { ethers } = require("hardhat");

async function main() {
  // Read from environment variable instead of CLI args
  const recipientAddress = process.env.TO;

  if (!recipientAddress) {
    console.error("❌ Error: Please provide a recipient address via the 'TO' env var.");
    console.log("Usage: TO=<ADDRESS> npx hardhat run scripts/fund.js --network localhost");
    process.exit(1);
  }

  if (!ethers.isAddress(recipientAddress)) {
    console.error(`❌ Error: Invalid Ethereum address: ${recipientAddress}`);
    process.exit(1);
  }

  const amountToSend = ethers.parseEther("100.0"); // 100 ETH
  const [sender] = await ethers.getSigners();

  console.log(`💸 Sending 100 ETH from ${sender.address}`);
  console.log(`   To: ${recipientAddress}`);

  const tx = await sender.sendTransaction({
    to: recipientAddress,
    value: amountToSend,
  });

  console.log(`   Tx Hash: ${tx.hash}`);
  await tx.wait();

  console.log(`✅ Successfully funded ${recipientAddress}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
