// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @dev Test only. A token stand-in for scripts/list-fee-token-exempt.js that answers the listing
 *      question in one of three wrong ways, chosen at deploy time: it never lists anyone (and
 *      accepts the call that should), it reverts with a reason, or it reverts with no data as a
 *      token with no such function does. It carries the symbol it is given and 18 decimals, so
 *      a pair can be deployed against it. Nothing here is deployed outside tests.
 */
contract ListingProbeToken {
  enum Answer {
    NeverListed,
    RevertsWithReason,
    RevertsEmpty
  }

  string public symbol;
  address public owner;
  Answer public answer;

  constructor(string memory _symbol, Answer _answer) {
    symbol = _symbol;
    owner = msg.sender;
    answer = _answer;
  }

  function decimals() external pure returns (uint8) {
    return 18;
  }

  function isTransferExempt(address) external view returns (bool) {
    if (answer == Answer.RevertsWithReason) {
      revert("listing unavailable");
    }
    if (answer == Answer.RevertsEmpty) {
      // solhint-disable-next-line reason-string
      revert();
    }
    return false;
  }

  /// @dev Accepted and ignored: the address stays unlisted.
  function setTransferExempt(address, bool) external {}
}
