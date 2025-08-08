// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// A simple mock ERC20 token for testing purposes.
contract MockAbleToken is ERC20 {
  constructor() ERC20("Mock Able Token", "ABLE") {}

  // Public mint function to give tokens to test accounts.
  function mint(address to, uint256 amount) external {
    _mint(to, amount);
  }
}
