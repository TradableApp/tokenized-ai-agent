require("dotenv").config({ path: process.env.ENV_FILE || ".env" });
require("@nomicfoundation/hardhat-toolbox");
require("@openzeppelin/hardhat-upgrades");
require("hardhat-gas-reporter");

const {
  PRIVATE_KEY,
  SAPPHIRE_MAINNET_RPC,
  SAPPHIRE_TESTNET_RPC,
  SAPPHIRE_LOCALNET_RPC,
  COINMARKETCAP_API_KEY,
} = process.env;

module.exports = {
  defaultNetwork: "hardhat",

  networks: {
    hardhat: {
      chainId: 1337,
    },
    sapphire: {
      url: SAPPHIRE_MAINNET_RPC || "https://sapphire.oasis.io",
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      chainId: 0x5afe,
    },
    "sapphire-testnet": {
      url: SAPPHIRE_TESTNET_RPC || "https://testnet.sapphire.oasis.io",
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      chainId: 0x5aff,
    },
    "sapphire-localnet": {
      url: SAPPHIRE_LOCALNET_RPC || "http://localhost:8545",
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      chainId: 0x5afd,
    },
  },

  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 10000,
      },
    },
  },

  gasReporter: {
    enabled: process.env.REPORT_GAS === "true", // Run with `REPORT_GAS=true npx hardhat test`
    currency: "USD",
    currencyDisplayPrecision: 8,
    outputFile: "gas-report.txt",
    noColors: true,
    coinmarketcap: COINMARKETCAP_API_KEY || "",
    offline: true, // Suppresses warnings when not using Etherscan
  },

  namedAccounts: {
    deployer: {
      default: 0,
    },
    user1: {
      default: 1,
    },
  },
};
