const { describeShape, isSet } = require("./settingShape");

// hardhat.config.js loads the root .env and then ENV_FILE with override, so a line in either file
// replaces what the operator typed before the command. For the settings below that would let a
// file decide whether a script sends: a DRY_RUN=0 (or empty) line turns a dry run into a real
// send, and a confirmation line confirms a mainnet send nobody typed. So what the shell holds is
// recorded before either file is loaded, and the scripts read these settings from the record.
//
// `hardhat run` forks the script with the environment the files were loaded into, so the record
// travels in the environment (SNAPSHOT_VAR), with the id of the process that took it: the forked
// script keeps its parent's record, and a record inherited from any other process is replaced.
const TYPED_SETTINGS = Object.freeze([
  "DRY_RUN",
  "DEPLOY_MAINNET_CONFIRMED",
  "REHEARSAL_MAINNET_CONFIRMED",
  "ORACLE_ADDRESS",
  "ANSWER_TX_HASH",
]);
const SNAPSHOT_VAR = "SENSEAI_TYPED_SETTINGS";

function readRecord(text) {
  try {
    const record = JSON.parse(text);
    if (
      record &&
      Number.isInteger(record.owner) &&
      record.values &&
      typeof record.values === "object"
    ) {
      return record;
    }
  } catch {
    // Not a record this module wrote.
  }
  return null;
}

/**
 * Records what `env` holds for TYPED_SETTINGS in env[SNAPSHOT_VAR], unless the record there was
 * taken by this process or by its parent (`fresh` replaces it whatever it is). Called before any
 * env file is loaded. Gives back the record's text, so the caller can put it back after loading a
 * file that might set SNAPSHOT_VAR itself.
 */
function captureTypedSettings(env, { pid = process.pid, ppid = process.ppid, fresh = false } = {}) {
  const current = readRecord(env[SNAPSHOT_VAR]);
  const own = current && (current.owner === pid || current.owner === ppid);
  if (fresh || !own) {
    const values = Object.fromEntries(TYPED_SETTINGS.map((name) => [name, env[name] ?? null]));
    env[SNAPSHOT_VAR] = JSON.stringify({ owner: pid, values });
  }
  return env[SNAPSHOT_VAR];
}

/** What was typed for each of TYPED_SETTINGS (undefined when unset), or null with no record. */
function typedSettings(env) {
  const record = readRecord(env[SNAPSHOT_VAR]);
  if (!record) return null;
  return Object.fromEntries(TYPED_SETTINGS.map((name) => [name, record.values[name] ?? undefined]));
}

const trimmed = (value) => (isSet(value) ? String(value).trim() : undefined);

/**
 * One problem for each of `names` whose value after the env files loaded (`processEnv`) is not
 * what was typed (`typedEnv`): an env file set it. An empty line and no line both count as unset.
 * Values are described by shape only.
 */
function typedOnlyProblems({ names, typedEnv, processEnv, envFile }) {
  if (!typedEnv) {
    return [
      `What was typed on the command line was not recorded (${SNAPSHOT_VAR}), so ${names.join(", ")} cannot be told apart from an env file's line: run the script through its package script`,
    ];
  }
  const file = envFile ?? "ENV_FILE";
  const problems = [];
  for (const name of names) {
    const typed = trimmed(typedEnv[name]);
    const loaded = trimmed(processEnv[name]);
    if (typed === loaded) continue;
    problems.push(
      typed === undefined
        ? `${name} is set in ${file} or the root .env (${describeShape(loaded)}), but it is read only from what is typed on the command line, since Hardhat loads those files over the shell: remove the line from both files, and type it before the command when it is meant`
        : `${name} was typed on the command line (${describeShape(typed)}), but ${file} sets it otherwise (${describeShape(loaded)}), and Hardhat loads that file over what is typed: remove the line from ${file} and run again`,
    );
  }
  return problems;
}

module.exports = {
  TYPED_SETTINGS,
  SNAPSHOT_VAR,
  captureTypedSettings,
  typedSettings,
  typedOnlyProblems,
};
