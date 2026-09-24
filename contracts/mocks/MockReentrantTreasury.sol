// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

/**
 * @title MockReentrantTreasury
 * @notice A treasury whose `receive()` re-enters the escrow that just paid it.
 * @dev The escrow's payouts moved from `transfer` to `Address.sendValue` so a Safe multisig
 *      treasury can receive them. That also removes the 2300-gas stipend which had made a
 *      callback impossible, so the non-reentrancy has to be asserted rather than inherited.
 *      The treasury is owner-set and this is not a live attack path — the point is to hold the
 *      property on the ESCROW rather than on the treasury it happens to be paired with, so it
 *      survives a redeploy against a different one.
 */
contract MockReentrantTreasury {
  address public escrow;
  bytes public payload;
  bool public reentryAttempted;
  bool public reentrySucceeded;
  bool private reentered;
  bytes public revertData;

  /// @notice Arm the callback. `_payload` is the encoded escrow call to attempt on payment.
  function arm(address _escrow, bytes calldata _payload) external {
    escrow = _escrow;
    payload = _payload;
    reentered = false;
    reentryAttempted = false;
    reentrySucceeded = false;
  }

  receive() external payable {
    // One shot only: without this the re-entrant call's own payout recurses until out of gas,
    // which would fail the outer call for the wrong reason and prove nothing.
    if (escrow == address(0) || reentered) {
      return;
    }
    reentered = true;
    reentryAttempted = true;

    // Deliberately swallowed: a reverting re-entry must not revert the ORIGINAL call, or the
    // test could not tell "the guard rejected the re-entry" from "the whole thing blew up".
    (bool ok, bytes memory ret) = escrow.call(payload);
    reentrySucceeded = ok;
    revertData = ret;
  }
}
