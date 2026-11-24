const fs = require("fs");
const dotenv = require("dotenv");

const { isSet } = require("./settingShape");

// Hardhat's config loads the root .env and then ENV_FILE over it, so the process environment
// holds both. A setting that must come from ENV_FILE alone is read again from the file, and one
// the file leaves out but the root .env or the shell sets is refused rather than used.

/** ENV_FILE parsed on its own, or null when it is not set. */
function readEnvFile(envFile) {
  if (!envFile) return null;
  let text;
  try {
    text = fs.readFileSync(envFile);
  } catch {
    throw new Error(`ENV_FILE names ${envFile}, which cannot be read`);
  }
  return dotenv.parse(text);
}

/**
 * Every name in `names` whose value in the process environment is not the one in ENV_FILE, as
 * one problem each. Values are never printed. `fileEnv` is null when ENV_FILE is not set.
 */
function fileOnlyProblems({ names, envFile, fileEnv, processEnv, howToRun }) {
  if (!envFile || !fileEnv) {
    return [
      `ENV_FILE is not set: ${names.join(", ")} are read from the file it names alone. ${howToRun}`,
    ];
  }
  const trimmed = (value) => (isSet(value) ? String(value).trim() : undefined);
  const problems = [];
  for (const name of names) {
    const inFile = trimmed(fileEnv[name]);
    const inEnv = trimmed(processEnv[name]);
    if (inFile === inEnv) continue;
    problems.push(
      inFile === undefined
        ? `${name} is not set in ${envFile} but is set in the root .env or the shell; it is read from ${envFile} alone, so remove it from the root .env and the shell, or set it in ${envFile}`
        : `${name} in the root .env or the shell differs from ${envFile}; it is read from ${envFile} alone, so remove it from the root .env and the shell`,
    );
  }
  return problems;
}

/** The process environment with each of `names` taken from ENV_FILE. */
function withFileValues(processEnv, fileEnv, names) {
  const env = { ...processEnv };
  if (fileEnv) {
    for (const name of names) env[name] = fileEnv[name];
  }
  return env;
}

module.exports = { readEnvFile, fileOnlyProblems, withFileValues };
