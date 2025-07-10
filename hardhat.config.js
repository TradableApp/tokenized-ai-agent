require("dotenv").config({ path: process.env.ENV_FILE || ".env" });
require("@nomicfoundation/hardhat-toolbox");
require("@openzeppelin/hardhat-upgrades");
require("hardhat-gas-reporter");

const {
  PRIVATE_KEY,
  SAPPHIRE_TESTNET_RPC,
  SAPPHIRE_MAINNET_RPC,
  SAPPHIRE_LOCALNET_RPC,
  COINMARKETCAP_API_KEY,
} = process.env;

module.exports = {
  // Best practice: Set the default network to `hardhat` for testing and development.
  // This avoids accidental transactions on live networks.
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
      // The optimizer is crucial for reducing contract size and gas costs.
      // It's a standard practice for production deployments.
      optimizer: {
        enabled: true,
        runs: 10000, // The number of runs should be tuned based on contract usage.
      },
    },
  },

  // etherscan: {
  //   apiKey: {
  //     sapphireTestnet: "", // Not supported currently
  //     sapphire: "", // Not supported currently
  //   },
  //   customChains: [
  //     {
  //       network: "sapphireTestnet",
  //       chainId: 23295,
  //       urls: {
  //         apiURL: "https://NOT_YET_SUPPORTED",
  //         browserURL: "https://testnet.explorer.oasis.io",
  //       },
  //     },
  //     {
  //       network: "sapphire",
  //       chainId: 23294,
  //       urls: {
  //         apiURL: "https://NOT_YET_SUPPORTED",
  //         browserURL: "https://explorer.oasis.io",
  //       },
  //     },
  //   ],
  // },

  gasReporter: {
    enabled: process.env.REPORT_GAS === "true", // Run with `REPORT_GAS=true npx hardhat test`
    currency: "USD",
    currencyDisplayPrecision: 8,
    outputFile: "gas-report.txt",
    noColors: true,
    coinmarketcap: COINMARKETCAP_API_KEY || "",
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
