require("dotenv").config({ path: process.env.ENV_FILE || ".env" });
require("@nomicfoundation/hardhat-toolbox");
require("@openzeppelin/hardhat-upgrades");
require("hardhat-gas-reporter");

const {
  PRIVATE_KEY,
  BASE_MAINNET_RPC,
  BASE_SEPOLIA_TESTNET_RPC,
  SAPPHIRE_MAINNET_RPC,
  SAPPHIRE_TESTNET_RPC,
  SAPPHIRE_LOCALNET_RPC,
  ETHERSCAN_API_KEY,
  COINMARKETCAP_API_KEY,
  REPORT_GAS,
} = process.env;

module.exports = {
  defaultNetwork: "hardhat",

  networks: {
    hardhat: {
      chainId: 31337,
    },
    localnet: {
      url: "http://127.0.0.1:8545", // This points to your running Hardhat node (npx hardhat node)
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      chainId: 31337,
    },
    base: {
      url: BASE_MAINNET_RPC || "https://mainnet.base.org",
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      chainId: 8453,
      verify: {
        etherscan: {
          apiUrl: "https://api-sepolia.basescan.org",
          apiKey: ETHERSCAN_API_KEY, // single Etherscan.io key
        },
      },
    },
    baseSepolia: {
      url: BASE_SEPOLIA_TESTNET_RPC || "https://sepolia.base.org",
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      chainId: 84532,
      verify: {
        etherscan: {
          apiUrl: "https://api-sepolia.basescan.org",
          apiKey: ETHERSCAN_API_KEY, // single Etherscan.io key
        },
      },
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

  // Configuration for Etherscan contract verification
  etherscan: {
    // It's good practice to provide a fallback to prevent errors
    apiKey: ETHERSCAN_API_KEY || "",
  },

  gasReporter: {
    enabled: REPORT_GAS === "true", // Run with `REPORT_GAS=true npx hardhat test`
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
