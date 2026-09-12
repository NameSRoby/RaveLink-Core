// [TITLE] Module: shared/validation/parse-boolean.js
// [TITLE] Purpose: boolean token normalization helper
// [TITLE] Functionality Index:
// [TITLE] - normalize mixed input types into deterministic boolean values
// [TITLE] - support tolerant truthy/falsy token parsing

function parseBoolean(value, fallback = false) {
  // [DEV] Parsing is intentionally permissive for API/query/env compatibility.
  // [DEV] Unknown tokens collapse to fallback to keep behavior deterministic.
  if (value === undefined || value === null || value === "") {
    return Boolean(fallback);
  }
  if (typeof value === "boolean") return value;
  const token = String(value).trim().toLowerCase();
  if (!token) return Boolean(fallback);
  if (["1", "true", "yes", "y", "on"].includes(token)) return true;
  if (["0", "false", "no", "n", "off"].includes(token)) return false;
  return Boolean(fallback);
}

module.exports = {
  parseBoolean
};
