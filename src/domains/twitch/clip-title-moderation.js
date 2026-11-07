/** Offline title policy shared by chat, deck buttons and the clip capability. */
const {
  RegExpMatcher,
  englishDataset,
  englishRecommendedTransformers,
  createSimpleTransformer,
} = require("obscenity");
const defaults = () => ({
  enabled: true,
  mode: "mask",
  useDefaultList: true,
  blockedWords: [],
  allowedWords: [],
});
const invalid = () =>
  Object.assign(Error("twitch_clip_moderation_invalid"), {
    code: "twitch_clip_moderation_invalid",
  });
const record = (v) => v && typeof v === "object" && !Array.isArray(v);
function normalizePolicy(input = {}, previous = defaults()) {
  if (!record(input) || Object.keys(input).some((k) => !Object.hasOwn(defaults(), k)))
    throw invalid();
  const next = { ...previous, ...input };
  if (
    typeof next.enabled !== "boolean" ||
    typeof next.useDefaultList !== "boolean" ||
    !["mask", "reject"].includes(next.mode)
  )
    throw invalid();
  for (const key of ["blockedWords", "allowedWords"]) {
    if (
      !Array.isArray(next[key]) ||
      next[key].length > 128 ||
      next[key].some(
        (term) =>
          typeof term !== "string" ||
          !term.trim() ||
          term.length > 64 ||
          /[\u0000-\u001f\u007f]/u.test(term),
      )
    )
      throw invalid();
    next[key] = [...new Set(next[key].map((term) => term.normalize("NFKC").trim()))];
    if (next[key].some((term) => term.length > 64)) throw invalid();
  }
  return next;
}
let english;
// Preserve spaces/word boundaries: stripping all punctuation can join innocent
// words into a false match. Only dotted/zero-width disguises are folded here.
const disguise = createSimpleTransformer((code) =>
  /[.\u00b7\p{Cf}]/u.test(String.fromCodePoint(code)) ? undefined : code,
);
const word = /[\p{L}\p{N}\p{M}_]/u;
const literal = (term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Unicode word edges; user input is always literal, never a regular expression. */
function intervals(input, terms) {
  const found = [];
  for (const term of terms) {
    const pattern = new RegExp(literal(term), "giu");
    for (const match of input.matchAll(pattern)) {
      const start = match.index,
        end = start + match[0].length;
      const before = Array.from(input.slice(0, start)).at(-1) || "";
      const after = Array.from(input.slice(end))[0] || "";
      if (
        (!word.test(Array.from(match[0])[0]) || !word.test(before)) &&
        (!word.test(Array.from(match[0]).at(-1)) || !word.test(after))
      )
        found.push([start, end]);
    }
  }
  return found;
}
function moderateTitle(value, policy) {
  const input = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const limit = (v) => {
    const result = v.slice(0, 100);
    return /[\ud800-\udbff]$/.test(result) ? result.slice(0, -1) : result;
  };
  if (!policy.enabled) return { accepted: true, title: limit(input), matched: false };
  let spans = intervals(input, policy.blockedWords);
  if (policy.useDefaultList) {
    english ||= new RegExpMatcher({
      ...englishDataset.build(),
      blacklistMatcherTransformers: [
        disguise,
        ...englishRecommendedTransformers.blacklistMatcherTransformers,
      ],
      whitelistMatcherTransformers: [
        disguise,
        ...englishRecommendedTransformers.whitelistMatcherTransformers,
      ],
    });
    spans.push(
      ...english.getAllMatches(input).map((match) => [match.startIndex, match.endIndex + 1]),
    );
  }
  const allowed = intervals(input, policy.allowedWords);
  spans = spans.filter(([start, end]) => !allowed.some(([a, b]) => start >= a && end <= b));
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged = [];
  for (const span of spans) {
    const prior = merged.at(-1);
    if (prior && span[0] < prior[1]) prior[1] = Math.max(prior[1], span[1]);
    else merged.push([...span]);
  }
  if (merged.length && policy.mode === "reject")
    return { accepted: false, title: "", matched: true, error: "twitch_clip_title_rejected" };
  let result = "",
    cursor = 0;
  for (const [start, end] of merged) {
    const prefix = input.slice(cursor, start);
    if (result.length + prefix.length + 4 > 100) {
      // Never publish a partial blocked term or half a replacement marker.
      return { accepted: true, title: limit(result + prefix).trimEnd(), matched: true };
    }
    result += prefix + "****";
    cursor = end;
  }
  return { accepted: true, title: limit(result + input.slice(cursor)), matched: merged.length > 0 };
}
module.exports = { defaults, normalizePolicy, moderateTitle };
