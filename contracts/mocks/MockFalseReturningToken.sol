// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockFalseReturningToken
 * @notice An ERC-20 that reports failure by RETURNING FALSE instead of reverting.
 * @dev The behaviour raw `transfer`/`transferFrom` calls silently ignore. Real tokens do this
 *      (and worse — USDT returns nothing at all), which is the reason SafeERC20 exists. Used to
 *      prove the escrow now reverts instead of booking a settlement that never moved any tokens.
 */
contract MockFalseReturningToken is ERC20 {
  constructor() ERC20("False Returning Token", "FALSE") {}

  function mint(address to, uint256 amount) external {
    _mint(to, amount);
  }

  function transfer(address, uint256) public pure override returns (bool) {
    return false;
  }

  function transferFrom(address, address, uint256) public pure override returns (bool) {
    return false;
  }
}
