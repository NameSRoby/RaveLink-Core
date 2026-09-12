// [TITLE] Module: shared/fuzzy/fuzzy-text.js
// [TITLE] Purpose: typo-tolerant token matching helpers
// [TITLE] Functionality Index:
// [TITLE] - normalize case, spacing, punctuation, and diacritics
// [TITLE] - compute memory-bounded Levenshtein distance
// [TITLE] - choose best fuzzy candidate with threshold + guardrails

const MAX_FUZZY_TOKEN_LENGTH = 256;

function normalizeLanguageText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, MAX_FUZZY_TOKEN_LENGTH);
}

function normalizeLookupToken(value) {
  return normalizeLanguageText(value).replace(/ /g, "");
}

function levenshteinDistance(aRaw, bRaw) {
  let a = String(aRaw || "").slice(0, MAX_FUZZY_TOKEN_LENGTH);
  let b = String(bRaw || "").slice(0, MAX_FUZZY_TOKEN_LENGTH);
  if (!a) return b.length;
  if (!b) return a.length;
  if (b.length > a.length) [a, b] = [b, a];
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  let current = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost
      );
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length];
}

function scoreCandidate(queryToken, candidateToken, distance) {
  if (!queryToken || !candidateToken) return -Infinity;
  if (queryToken === candidateToken) return 1000;

  let score = 0;
  if (candidateToken.startsWith(queryToken) || queryToken.startsWith(candidateToken)) {
    score += 260;
  }
  if (candidateToken.includes(queryToken) || queryToken.includes(candidateToken)) {
    score += 120;
  }

  const maxLen = Math.max(queryToken.length, candidateToken.length, 1);
  const lengthGap = Math.abs(queryToken.length - candidateToken.length);
  const ratio = distance / maxLen;
  score += Math.round((1 - Math.min(1, ratio)) * 300);
  score -= distance * 30;
  score -= lengthGap * 24;

  return score;
}

function findBestFuzzyMatch(query, candidates = [], options = {}) {
  const queryToken = normalizeLookupToken(query);
  if (!queryToken) return null;
  const minScore = Number.isFinite(Number(options.minScore)) ? Number(options.minScore) : 220;
  const maxDistanceRatio = Number.isFinite(Number(options.maxDistanceRatio))
    ? Number(options.maxDistanceRatio)
    : 0.45;

  // [DEV] Candidate gating happens before scoring to avoid distant false positives.
  let best = null;
  for (const value of candidates) {
    const candidateToken = normalizeLookupToken(value);
    if (!candidateToken) continue;
    let distance = levenshteinDistance(queryToken, candidateToken);
    if (options.allowTranspositions === true && distance === 2 && queryToken.length >= 4 && queryToken.length === candidateToken.length) {
      const mismatch = [...queryToken].map((character, index) => character === candidateToken[index] ? -1 : index).filter(index => index >= 0);
      if (mismatch.length === 2 && mismatch[1] === mismatch[0] + 1 && queryToken[mismatch[0]] === candidateToken[mismatch[1]] && queryToken[mismatch[1]] === candidateToken[mismatch[0]]) distance = 1;
    }
    const ratio = distance / Math.max(queryToken.length, candidateToken.length, 1);
    const lengthGap = Math.abs(candidateToken.length - queryToken.length);
    const hardPrefixPass =
      candidateToken.startsWith(queryToken) ||
      queryToken.startsWith(candidateToken) ||
      (candidateToken.includes(queryToken) && lengthGap <= 2) ||
      (queryToken.includes(candidateToken) && lengthGap <= 2);
    if (!hardPrefixPass && ratio > maxDistanceRatio) continue;

    const score = scoreCandidate(queryToken, candidateToken, distance);
    if (score < minScore) continue;
    if (!best || score > best.score || (score === best.score && candidateToken.length < best.token.length)) {
      best = {
        value,
        token: candidateToken,
        score,
        distance,
        distanceRatio: Number(ratio.toFixed(3))
      };
    }
  }

  if (!best) return null;
  return {
    value: best.value,
    score: best.score,
    distance: best.distance,
    distanceRatio: best.distanceRatio
  };
}

module.exports = {
  MAX_FUZZY_TOKEN_LENGTH,
  normalizeLanguageText,
  normalizeLookupToken,
  levenshteinDistance,
  findBestFuzzyMatch
};
