const { Uploader } = require("@irys/upload");
const { BaseEth } = require("@irys/upload-ethereum");
const { sendAlert } = require("../alerting");

let irysUploader;
const graphqlEndpoint = "https://uploader.irys.xyz/graphql"; // Use the main query endpoint

/**
 * Initializes the Irys uploader instance and performs a proactive balance check/top-up.
 */
async function initializeIrys() {
  const paymentKey = process.env.IRYS_PAYMENT_PRIVATE_KEY;
  const network = process.env.IRYS_NETWORK;
  const rpcUrl = process.env.IRYS_PAYMENT_RPC_URL;

  if (!paymentKey || !network || !rpcUrl) {
    throw new Error(
      "Missing required Irys environment variables: IRYS_PAYMENT_PRIVATE_KEY, IRYS_NETWORK, IRYS_PAYMENT_RPC_URL",
    );
  }

  const uploaderBuilder = Uploader(BaseEth).withWallet(paymentKey);

  if (network === "devnet") {
    irysUploader = await uploaderBuilder.withRpc(rpcUrl).devnet();
  } else {
    irysUploader = await uploaderBuilder;
  }
  console.log(
    `Irys Uploader initialized for network: ${network} using token: ${irysUploader.token}.`,
  );

  await topUpIrysBalanceIfNeeded(); // Proactive check and fund on startup
}

/**
 * Proactively checks the Irys balance and funds it if it falls below a threshold.
 */
async function topUpIrysBalanceIfNeeded() {
  if (!irysUploader) throw new Error("Irys not initialized.");

  // Devnet uploads are free — no funding required.
  if (process.env.IRYS_NETWORK === "devnet") return;

  try {
    const atomicBalance = await irysUploader.getBalance();
    const balanceConverted = parseFloat(irysUploader.utils.fromAtomic(atomicBalance));
    console.log(`Irys wallet balance: ${balanceConverted} ${irysUploader.token}`);

    const threshold = parseFloat(process.env.IRYS_BALANCE_ALERT_THRESHOLD) || 0.02;

    if (balanceConverted < threshold) {
      const topUpAmount = parseFloat(process.env.IRYS_TOP_UP_AMOUNT) || 0.05;
      const amountToFundAtomic = irysUploader.utils.toAtomic(topUpAmount);

      await sendAlert(
        "Irys Wallet Balance Low - Auto-Funding Initiated",
        `Balance of ${balanceConverted} ${irysUploader.token} is below threshold of ${threshold}. Attempting to add ${topUpAmount} ${irysUploader.token}.`,
      );

      const fundTx = await irysUploader.fund(amountToFundAtomic);
      const newAtomicBalance = await irysUploader.getBalance();
      const newBalanceConverted = irysUploader.utils.fromAtomic(newAtomicBalance);

      await sendAlert(
        "Irys Wallet Auto-Fund Successful",
        `Successfully funded ${irysUploader.utils.fromAtomic(fundTx.quantity)} ${irysUploader.token}. New balance is ${newBalanceConverted} ${irysUploader.token}.`,
      );
    }
  } catch (e) {
    console.error("CRITICAL: Failed to check or top-up Irys balance: ", e);

    const alertMessage = `The oracle failed to fund its Irys balance. Manual intervention is required immediately. Error: ${e.message}`;

    await sendAlert("CRITICAL: Irys Auto-Funding FAILED", alertMessage);

    throw new Error(alertMessage);
  }
}

/**
 * Ensures the Irys balance is sufficient for a given data size, topping up if necessary.
 * @param {number} dataSizeBytes The size of the data to be uploaded in bytes.
 */
async function ensureBalanceIsSufficient(dataSizeBytes) {
  const priceAtomic = await irysUploader.getPrice(dataSizeBytes);
  const balanceAtomic = await irysUploader.getBalance();

  if (priceAtomic.isGreaterThan(balanceAtomic)) {
    console.warn(
      `Insufficient Irys balance for upload. Current: ${irysUploader.utils.fromAtomic(balanceAtomic)}, Required: ${irysUploader.utils.fromAtomic(priceAtomic)}. Triggering top-up...`,
    );

    await topUpIrysBalanceIfNeeded();

    // Final check after top-up
    const finalBalance = await irysUploader.getBalance();

    if (priceAtomic.isGreaterThan(finalBalance)) {
      throw new Error("Insufficient Irys balance even after attempting to top up.");
    }
  }
}

/**
 * Uploads data to Arweave, ensuring sufficient balance before the attempt.
 * @param {Buffer} dataBuffer The data to upload.
 * @returns {Promise<string>} The Arweave transaction ID (CID).
 */
async function uploadData(dataBuffer, tags = []) {
  if (!irysUploader) throw new Error("Irys not initialized.");

  try {
    // Proactive check to ensure balance is sufficient before attempting upload.
    await ensureBalanceIsSufficient(dataBuffer.length);

    const receipt = await irysUploader.upload(dataBuffer, { tags });
    console.log(`Data uploaded ==> https://gateway.irys.xyz/${receipt.id}`);

    // Log balance post-upload for monitoring, but don't check threshold here.
    const newBalance = await irysUploader.getBalance();
    console.log(`Irys balance after upload: ${irysUploader.utils.fromAtomic(newBalance)}`);

    return receipt.id;
  } catch (e) {
    const errorMessage = `Upload to Irys failed critically. Error: ${e.message}`;

    console.error(errorMessage, e);

    await sendAlert("CRITICAL: Irys Upload Failed", errorMessage);

    throw e; // Re-throw to be handled by the calling event handler.
  }
}

/**
 * Fetches data from Arweave.
 * @param {string} cid The Arweave transaction ID (CID) of the data to fetch.
 * @returns {Promise<string>} The raw data as a string.
 */
async function fetchData(cid) {
  const response = await fetch(`https://gateway.irys.xyz/${cid}`);

  if (!response.ok) {
    throw new Error(`Failed to fetch CID ${cid} from gateway. Status: ${response.status}`);
  }

  return response.text();
}

/**
 * Queries for a transaction ID by its tags using Irys GraphQL endpoint.
 * @param {Array<{name: string, value: string}>} tags The tags to search for.
 * @returns {Promise<string|null>} The first matching transaction ID, or null.
 */
/**
 * Render a string as a GraphQL string literal, escaped.
 *
 * `JSON.stringify` is the escaper on purpose: GraphQL's string-literal syntax is a subset of
 * JSON's — same double quotes, same backslash escapes, same \uXXXX form — so its output is a
 * valid GraphQL literal, quotes included. Using it beats hand-rolling a replace chain that
 * forgets control characters.
 *
 * Non-strings are REJECTED rather than coerced. `String({})` yields "[object Object]", which
 * would quietly query for the wrong thing instead of reporting a caller's mistake.
 */
function gqlString(value, field) {
  if (typeof value !== "string") {
    throw new TypeError(`GraphQL tag ${field} must be a string, received ${typeof value}`);
  }
  return JSON.stringify(value);
}

/**
 * Build the tag-filter query document.
 *
 * Separated from the fetch so the escaping is directly testable — the injection risk lives
 * entirely in how this string is assembled, and a test that has to stub the network to reach it
 * is a test nobody trusts.
 *
 * Today's callers pass `${chainId}-${conversationId}`, both chain-derived, so unescaped
 * interpolation was latent rather than exploitable. That is an accident of the current call
 * sites, not a property of this function, which accepts arbitrary tags.
 *
 * GraphQL VARIABLES would be the textbook fix and remove the class outright. Not used here only
 * because it needs the remote schema's input type name (`TagFilter`) confirmed against the live
 * Irys gateway, and getting that wrong breaks conversation-key lookup — a worse outcome than the
 * latent flaw. Worth upgrading next time someone can run it against the real endpoint.
 */
function buildTagQuery(tags) {
  const filters = tags
    .map(
      (tag) =>
        `{ name: ${gqlString(tag.name, "name")}, values: [${gqlString(tag.value, "value")}] }`,
    )
    .join(",\n                    ");

  return `
        query {
            transactions(
                tags: [
                    ${filters}
                ],
                first: 1,
                order: DESC
            ) {
                edges {
                    node {
                        id
                    }
                }
            }
        }
    `;
}

async function queryTransactionByTags(tags) {
  const query = buildTagQuery(tags);
  try {
    const response = await fetch(graphqlEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    if (!response.ok) {
      throw new Error(`GraphQL query failed with status: ${response.status}`);
    }
    const json = await response.json();
    const edges = json?.data?.transactions?.edges;
    if (edges && edges.length > 0) {
      return edges[0].node.id;
    }
    return null;
  } catch (error) {
    console.error("Error querying Irys GQL for tags:", error);
    throw error;
  }
}

module.exports = {
  initializeIrys,
  uploadData,
  fetchData,
  queryTransactionByTags,
  buildTagQuery,
};
