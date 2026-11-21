const { ethers } = require("ethers");

const { RehearsalError } = require("./values");

// A token that moves only to or from addresses its owner has listed answers this. An ordinary
// token has no such function.
const TRANSFER_RULE_ABI = ["function isTransferExempt(address account) view returns (bool)"];

// A node's whole answer to a revert that carried no data, with nothing after it. A reason after
// it ("execution reverted: ...") means the contract said something, and its data was dropped.
const BARE_REVERT = /^execution reverted$/i;

/**
 * True when a call reverted with no data at all: what a contract with no such function and no
 * fallback answers. Exactly two shapes count: data of exactly `0x`, or no data and a message
 * that is the node's bare revert text. A revert with data or with a reason is the contract's
 * own answer, and a node that refused or failed the request is no answer; neither is taken for
 * a missing function.
 *
 * The error comes in three forms. ethers turns a JSON-RPC error into CALL_EXCEPTION with the
 * node's own error under `info.error`. Hardhat's HTTP provider throws a ProviderError carrying
 * the node's numeric code and message, and `data` only when the node sent it. The in-process
 * Hardhat network throws its own error with the empty data. Any other ethers code is refused,
 * and so is the bare text on an error with no code: nothing says a node answered.
 */
function isEmptyRevert(error) {
  if (error === null || typeof error !== "object") return false;
  if (typeof error.code === "string" && error.code !== "CALL_EXCEPTION") return false;
  if (error.data === "0x") return true;
  if (error.data !== undefined && error.data !== null) return false;
  // The text alone proves nothing: it counts only on an error whose code says a node answered.
  const fromEthers = error.code === "CALL_EXCEPTION";
  if (!fromEthers && typeof error.code !== "number") return false;
  const message = fromEthers ? error.info?.error?.message : error.message;
  return BARE_REVERT.test(String(message ?? "").trim());
}

/**
 * The escrow's token, and whether it keeps a list (`restricted`) with the Safe on it (`listed`),
 * or `unknown` with the error when the answer was neither a yes, a no nor a missing function.
 */
async function readTransferRule({ escrow, safe, runner }) {
  const token = await escrow.ableToken();
  const rule = new ethers.Contract(token, TRANSFER_RULE_ABI, runner);
  try {
    const listed = await rule.isTransferExempt(safe);
    return { token, restricted: true, listed: listed === true };
  } catch (error) {
    if (isEmptyRevert(error)) return { token, restricted: false, listed: false };
    return { token, unknown: true, cause: error };
  }
}

/**
 * Why the Safe must not become the treasury, or null when it may. A token that keeps a list
 * moves only when the sender or the recipient is listed, so with an unlisted Safe as the
 * treasury every fee a user pays straight to the treasury is refused until the restore: the
 * cancellation fee, and the branch and metadata (rename or delete) fees. The escrow's own
 * payment of an answered prompt's fee still moves while the escrow is listed. An answer that
 * cannot be read is refused too: a guess either way could leave users' payments refused while
 * the Safe is the treasury.
 */
async function treasuryRefusal({ escrow, safe, runner, log }) {
  const { token, restricted, listed, unknown, cause } = await readTransferRule({
    escrow,
    safe,
    runner,
  });
  if (unknown) {
    return {
      reason: `The rehearsal could not tell whether the escrow's token ${token} moves only to or from addresses its owner has listed: asking it whether the Safe ${safe} is listed gave no yes or no.`,
      advice: "Check the token, then run again.",
      cause,
    };
  }
  if (!restricted) {
    log(`The escrow's token ${token} does not restrict who it moves between.`);
    return null;
  }
  if (listed) {
    log(`The escrow's token ${token} keeps a list, and the Safe ${safe} is on its list.`);
    return null;
  }
  return {
    reason: `The escrow's token ${token} moves only to or from addresses its owner has listed, and the Safe ${safe} is not on its list. While the Safe is the treasury, every fee a user pays straight to the treasury would be refused: the fee for cancelling a prompt, and the fee for a branch or for a rename or delete of a conversation. (An answered prompt's fee, which the escrow pays the treasury, would still move while the escrow is listed.)`,
    advice:
      "Have the token's owner list the Safe, or rehearse with a Safe that is listed, then run again.",
    // A resume refuses another Safe (`beginRun`), so that way out needs the snapshot moved.
    resumedAdvice: ({ file, sent }) =>
      `Have the token's owner list the Safe, then run again. To rehearse with another Safe that is listed instead, move the snapshot at ${file} aside${sent.length > 0 ? " once these restores are done" : ""} (keep it: it holds the values from before the rehearsal), since a resumed run refuses another Safe; a fresh run then starts from the live state.`,
  };
}

// Each restore and the set it undoes.
const SET_OF = {
  "fee-restore": "fee-set",
  "treasury-restore": "treasury-set",
  "oracle-remove": "oracle-add",
};

/**
 * The decisions of a resumed run that is refused (its treasury step, or its snapshot): every restore whose set is
 * already done (or seen on the chain) is still sent, so no rehearsal value is left live; a
 * restore that already ran without a record is kept so that its record is written; and every
 * other step is held back. Returns the decisions, and the ids sent and held.
 */
function holdUnstarted(decisions, reason = "held back: the treasury step was refused") {
  const actionOf = Object.fromEntries(decisions.map((d) => [d.step.id, d.action]));
  const setStarted = (id) => ["skip", "observe"].includes(actionOf[SET_OF[id]]);
  const kept = (d) =>
    d.action === "skip" ||
    (["send", "observe"].includes(d.action) && SET_OF[d.step.id] && setStarted(d.step.id)) ||
    (d.action === "observe" &&
      Object.entries(SET_OF).some(
        ([restore, set]) => set === d.step.id && actionOf[restore] === "send",
      ));
  const sent = [];
  const held = [];
  const next = decisions.map((d) => {
    if (kept(d)) {
      if (d.action === "send") sent.push(d.step.id);
      return d;
    }
    held.push(d.step.id);
    return { step: d.step, action: "skip", reason };
  });
  return { decisions: next, sent, held };
}

/**
 * A refused run's error, saying exactly what it sent and what it held back. `refusal.advice` is
 * text or a function of what was sent. `resumedFile` is the snapshot a resumed run read; a
 * refusal with `resumedAdvice` then says how another Safe can be used.
 */
function refusedRun({ refusal, sent = [], held = [], dryRun, resumedFile = null }) {
  const list = (ids) => ids.map((id) => `[${id}]`).join(", ");
  const parts = [refusal.reason];
  if (sent.length === 0) parts.push(dryRun ? "Nothing would be sent." : "Nothing was sent.");
  else
    parts.push(
      `${dryRun ? "Would send" : "Sent"}: ${list(sent)}, to restore what an earlier run set.`,
    );
  if (held.length > 0) parts.push(`${dryRun ? "Would not send" : "Not sent"}: ${list(held)}.`);
  let { advice } = refusal;
  if (resumedFile && refusal.resumedAdvice)
    advice = refusal.resumedAdvice({ file: resumedFile, sent });
  parts.push(typeof advice === "function" ? advice({ sent }) : advice);
  return new RehearsalError(parts.join(" "), refusal.cause ? { cause: refusal.cause } : undefined);
}

module.exports = {
  isEmptyRevert,
  readTransferRule,
  treasuryRefusal,
  holdUnstarted,
  refusedRun,
};
