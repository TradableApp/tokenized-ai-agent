// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

interface ISapphireAIAgent {
  /**
   * @notice Returns the next promptId that will be generated.
   */
  function promptIdCounter() external view returns (uint256);

  function storeCancellation(uint256 _promptId, address _user) external;

  /**
   * @notice Submits a new prompt after payment has been secured.
   * @param _promptId The unique identifier for the prompt.
   * @param _user The address of the user who initiated the prompt.
   * @param _prompt The plaintext prompt from the user.
   */
  function submitPrompt(uint256 _promptId, address _user, string calldata _prompt) external;
}
