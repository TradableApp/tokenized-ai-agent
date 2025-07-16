const { start } = require("./chatBotOracle");
const { setupProviderAndSigner, getContractArtifacts } = require("./contractUtility");

console.log("Starting Node.js ROFL Oracle Service...");

const signer = setupProviderAndSigner(
  process.env.NETWORK_NAME || "sapphire-testnet",
  process.env.PRIVATE_KEY,
);

const { abi } = getContractArtifacts("Oracle");
const contract = new signer.provider.constructor.Contract(
  process.env.CONTRACT_ADDRESS,
  abi,
  signer,
);

start();
