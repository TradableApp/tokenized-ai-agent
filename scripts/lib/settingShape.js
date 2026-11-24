/**
 * A setting's value described by its shape alone: empty, its length, whether it starts with 0x
 * and whether the rest is hex. A refusal says this and never the value, so a key pasted into the
 * wrong setting is not printed.
 */
function describeShape(value) {
  if (value === undefined || value === null) return "unset";
  const text = String(value);
  if (text.trim() === "") return "empty";
  const parts = [`${text.length} characters`];
  if (text.startsWith("0x")) {
    parts.push("starting with 0x");
    parts.push(/^0x[0-9a-fA-F]+$/.test(text) ? "all hex after it" : "not all hex after it");
  } else {
    parts.push("not starting with 0x");
  }
  return parts.join(", ");
}

/** True when a setting holds something other than blanks. */
function isSet(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

module.exports = { describeShape, isSet };
