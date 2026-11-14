const { ethers } = require("ethers");

/** The error ethers itself throws for a refused request, built by ethers, not by hand. */
function refusedByProvider(status = 429, statusText = "Too Many Requests", headers = {}) {
  const request = new ethers.FetchRequest("https://rpc.example/v2/not-a-real-key");
  const response = new ethers.FetchResponse(status, statusText, headers, null, request);
  try {
    response.assertOk();
  } catch (error) {
    return error;
  }
  throw new Error("assertOk should have thrown");
}

module.exports = { refusedByProvider };
