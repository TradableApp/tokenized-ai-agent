// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

interface IEVMAIAgentEscrow {
  /**
   * @notice Releases the escrowed payment to the treasury upon successful completion.
   * @param _escrowId The unique identifier of the job to finalize.
   */
  function finalizePayment(uint256 _escrowId) external;
}
