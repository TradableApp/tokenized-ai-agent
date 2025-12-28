// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

/**
 * @title ISapphireAIAgentEscrow Interface
 * @dev Defines the function(s) on the escrow contract that the main AI Agent contract needs to call.
 */
interface ISapphireAIAgentEscrow {
  /**
   * @notice Releases the escrowed payment to the treasury upon successful completion.
   * @dev This is called by the SapphireAIAgent contract after the oracle submits a valid answer.
   * @param _escrowId The unique identifier of the job to finalize.
   */
  function finalizePayment(uint256 _escrowId) external;
}
