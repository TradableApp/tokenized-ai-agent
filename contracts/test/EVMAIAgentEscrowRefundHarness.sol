// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import { EVMAIAgentEscrow } from "../../contracts/EVMAIAgentEscrow.sol";

/**
 * @title EVMAIAgentEscrowRefundHarness
 * @dev Test-only. Puts an escrow in the state a refund leaves behind when the agent never
 *      recorded it (a refund made before the agent could record refunds, or one whose record
 *      failed), so the retry can be exercised against the real agent.
 */
contract EVMAIAgentEscrowRefundHarness is EVMAIAgentEscrow {
  /**
   * @notice Marks a pending escrow REFUNDED without telling the agent and without moving funds.
   * @dev Refuses anything but a pending escrow, so a test cannot rewrite a settled one by accident.
   * @param _escrowId The ID of the escrow to mark.
   */
  function markRefundedWithoutRecord(uint256 _escrowId) external {
    require(escrows[_escrowId].status == EscrowStatus.PENDING, "Harness: escrow is not pending");
    escrows[_escrowId].status = EscrowStatus.REFUNDED;
  }
}
