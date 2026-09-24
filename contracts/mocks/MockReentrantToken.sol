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
  bool public reentrySucceeded;
  bool private reentered;
  bool private useCall;

  constructor() ERC20("Reentrant Token", "REENT") {}

  function mint(address to, uint256 amount) external {
    _mint(to, amount);
  }

  /// @notice Arm an OBSERVING callback: staticcall, so it reads state without changing it.
  function arm(address _target, bytes calldata _payload) external {
    target = _target;
    payload = _payload;
    reentered = false;
    useCall = false;
    reentrySucceeded = false;
  }

  /**
   * @notice Arm a genuinely RE-ENTRANT callback: a real CALL that can write state.
   * @dev `arm` uses staticcall, which cannot SSTORE — so an "attack" armed with it is inert by
   *      construction and a test built on it passes whether or not the escrow is ordered
   *      correctly. That is exactly what happened: the double-refund test stayed green under a
   *      mutation that moved the effects back after the first token call. This variant performs
   *      the attack for real, and `reentrySucceeded` records whether the escrow let it through.
   */
  function armCall(address _target, bytes calldata _payload) external {
    target = _target;
    payload = _payload;
    reentered = false;
    useCall = true;
    reentrySucceeded = false;
  }

  /// @dev Fires once, so a contract missing the guard recurses exactly one extra level.
  function transferFrom(
    address from,
    address to,
    uint256 amount
  ) public override returns (bool) {
    if (target != address(0) && !reentered) {
      reentered = true;
      if (useCall) {
        // A REAL re-entrant call. The result is swallowed rather than bubbled, because an
        // attacker would swallow it too: a revert inside the callback must not abort the outer
        // settlement, or the test would pass for the wrong reason.
        (bool ok, ) = target.call(payload);
        reentrySucceeded = ok;
      } else {
        // STATICCALL, and the returndata is kept. The assertion is about what the escrow's state
        // LOOKED LIKE at the moment it called out — which is the property checks-effects-
        // interactions actually guarantees.
        (bool ok, bytes memory ret) = target.staticcall(payload);
        if (ok) {
          observed = ret;
        }
      }
    }
    return super.transferFrom(from, to, amount);
  }
}
