// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

interface ISapphireAIAgent {
  /**
   * @notice Returns the next promptId that will be generated.
   */
  function promptIdCounter() external view returns (uint256);

  /**
   * @notice Submits a new prompt after payment has been secured.
   * @param _promptId The unique identifier for the prompt.
   * @param _prompt The plaintext prompt from the user.
   */
  function submitPrompt(uint256 _promptId, string calldata _prompt) external;
}
