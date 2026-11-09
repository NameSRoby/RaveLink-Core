/** Consume every supplied color, preserving taught names and descriptors.
 * Commas are unambiguous; space-separated lists prefer complete exact names.
 * Only individual words use typo matching, so a list cannot collapse to red.
 */
module.exports = function raveColorList(text, directiveService) {
  if (text.includes(",")) return text.split(/\s*,\s*/).map((s) => s.trim());
  const words = text.split(/\s+/);
  if (words.length > 64 || text.length > 768) return [];
  const memo = new Map();
  function split(start, remaining) {
    if (start === words.length) return [];
    if (!remaining) return null;
    const key = `${start}:${remaining}`;
    if (memo.has(key)) return memo.get(key);
    for (let end = words.length; end > start; end--) {
      const token = words.slice(start, end).join(" ");
      if (token.length > 96) continue;
      const parsed = directiveService.parseTwitchColorDirective(token, {
        wholeOnly: true,
        ...(end === start + 1 ? {} : { allowFuzzy: false }),
      });
      if (!parsed.ok || !parsed.hex) continue;
      const rest = split(end, remaining - 1);
      if (rest) {
        const result = [token, ...rest];
        memo.set(key, result);
        return result;
      }
    }
    memo.set(key, null);
    return null;
  }
  return split(0, 8) || [];
};
