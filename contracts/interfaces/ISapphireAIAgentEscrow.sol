// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

interface ISapphireAIAgentEscrow {
  /**
   * @notice Releases the escrowed payment to the treasury upon successful completion.
   * @param _promptId The unique identifier of the prompt to finalize.
   */
  function finalizePayment(uint256 _promptId) external;
}
