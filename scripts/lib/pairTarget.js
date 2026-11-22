const { describeShape, isSet } = require("./settingShape");
const { fileOnlyProblems, withFileValues } = require("./envFile");
const { LOCAL_NETWORKS } = require("./networks");

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
// The contracts a script acts on, by the setting that names each.
const PAIR_TARGET_VARS = Object.freeze({
  agent: "AI_AGENT_CONTRACT_ADDRESS",
  escrow: "AI_AGENT_ESCROW_CONTRACT_ADDRESS",
  token: "TOKEN_CONTRACT_ADDRESS",
});

/**
 * The settings a script acts on, keyed as `vars` names them, with every problem found. On a live
 * network they are read from ENV_FILE alone (one only the root .env or the shell sets is
 * refused) and each key in `requiredLive` must be set; on a local network the merged environment
 * is used and `requiredLocal` must be set. An address must be one; values are described by shape.
 */
function resolveTarget({
  networkName,
  envFile,
  fileEnv,
  processEnv,
  vars,
  addressKeys,
  requiredLive,
  requiredLocal,
  howToRun,
}) {
  const live = !LOCAL_NETWORKS.has(networkName);
  const names = Object.values(vars);
  const problems = live ? fileOnlyProblems({ names, envFile, fileEnv, processEnv, howToRun }) : [];
  const env = live ? withFileValues(processEnv, fileEnv, names) : processEnv;
  const required = live ? requiredLive : requiredLocal;
  const values = {};
  for (const [key, name] of Object.entries(vars)) {
    const value = env[name];
    values[key] = isSet(value) ? String(value).trim() : null;
    if (values[key] === null) {
      if (required.includes(key)) {
        problems.push(
          `${name} must be set${live ? ` in ${envFile ?? "ENV_FILE"}` : ""} on ${networkName}`,
        );
      }
    } else if (addressKeys.includes(key) && !ADDRESS_RE.test(values[key])) {
      problems.push(`${name} is not an address (${describeShape(value)})`);
    }
  }
  return { values, problems };
}

/** How a contract the script acts on is printed: its address, or that it is not set. */
const shown = (value) => value ?? "not set";

module.exports = { PAIR_TARGET_VARS, resolveTarget, shown };
