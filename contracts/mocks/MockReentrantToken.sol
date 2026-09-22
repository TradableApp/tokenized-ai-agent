// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockReentrantToken
 * @notice An ERC-20 that re-enters a target contract from inside `transferFrom`.
 * @dev Exists to prove that escrow settlement writes its state BEFORE it calls out. $ABLE itself
 *      is a plain OpenZeppelin ERC-20 and never calls back, and the escrow fixes its token
 *      address at initialize with no setter — so this is not a live attack path. It is the only
 *      way to assert the checks-effects-interactions ordering as a property of the escrow rather
 *      than as a property of the token it happens to be paired with.
 */
contract MockReentrantToken is ERC20 {
  address public target;
  bytes public payload;
  bytes public observed;
  bool private reentered;

  constructor() ERC20("Reentrant Token", "REENT") {}

  function mint(address to, uint256 amount) external {
    _mint(to, amount);
  }

  /// @notice Arm the callback. `_payload` is the call to replay against `_target`.
  function arm(address _target, bytes calldata _payload) external {
    target = _target;
    payload = _payload;
    reentered = false;
  }

  /// @dev Fires once, so a contract missing the guard recurses exactly one extra level.
  function transferFrom(
    address from,
    address to,
    uint256 amount
  ) public override returns (bool) {
    if (target != address(0) && !reentered) {
      reentered = true;
      // STATICCALL, and the returndata is kept. The assertion is about what the escrow's state
      // LOOKED LIKE at the moment it called out — which is the property checks-effects-
      // interactions actually guarantees, and the only one observable without a live exploit.
      (bool ok, bytes memory ret) = target.staticcall(payload);
      if (ok) {
        observed = ret;
      }
    }
    return super.transferFrom(from, to, amount);
  }
}
