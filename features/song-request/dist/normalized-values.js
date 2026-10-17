/**
 * Shared domain/overlay normalization, kept inside the self-contained feature.
 * Normalize Unicode before removing control characters and collapsing spaces;
 * then enforce the caller's field bound. Integers outside their declared range
 * use a migration/default value rather than being silently clamped into range.
 * Portable catalog text has a different whitespace policy and stays separate.
 */
function text(value, maximum) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}
function integer(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum && number <= maximum ? number : fallback;
}
module.exports = { text, integer };
