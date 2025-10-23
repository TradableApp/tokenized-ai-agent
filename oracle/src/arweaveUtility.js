const { Uploader } = require("@irys/upload");
const { BaseEth } = require("@irys/upload-ethereum");
const { sendAlert } = require("./alerting");

let irysUploader;

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
async function uploadData(dataBuffer) {
  if (!irysUploader) throw new Error("Irys not initialized.");

  try {
    // Proactive check to ensure balance is sufficient before attempting upload.
    await ensureBalanceIsSufficient(dataBuffer.length);

    const tags = [{ name: "Content-Type", value: "application/octet-stream" }];
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

module.exports = {
  initializeIrys,
  uploadData,
};
