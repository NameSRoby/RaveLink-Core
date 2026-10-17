/**
 * Common numeric coercion for fixture settings and brand transports.
 * Non-finite input uses the caller's numeric fallback; finite input is bounded.
 * Keep this policy distinct from integer-only validators and clamps whose zero
 * default intentionally means their lower bound. Those have different contracts.
 */
module.exports = function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return Number(fallback);
  return Math.min(Number(max), Math.max(Number(min), parsed));
};
