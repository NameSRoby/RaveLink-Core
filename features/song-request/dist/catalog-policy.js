const DERIVATIVE_KINDS = Object.freeze([
  "cover", "instrumental", "karaoke", "remix", "remaster", "live", "acoustic", "slowed", "sped_up",
  "nightcore", "lyrics", "extended", "edit", "reaction", "mashup", "fanmade", "tutorial", "enhanced"
]);

const DEFAULT_CATALOG_POLICY = Object.freeze({
  allowNonMusic: false,
  minimumSubscribers: 100000,
  minimumViews: 50000,
  minimumConfidence: 0.4,
  derivatives: Object.freeze(Object.fromEntries(DERIVATIVE_KINDS.map(kind => [kind, true])))
});

function boundedNumber(value, minimum, maximum, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function catalogPolicyFrom(input, fallback = DEFAULT_CATALOG_POLICY) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const sourceDerivatives = source.derivatives && typeof source.derivatives === "object" ? source.derivatives : {};
  const currentDerivatives = fallback.derivatives || DEFAULT_CATALOG_POLICY.derivatives;
  return {
    allowNonMusic: typeof source.allowNonMusic === "boolean" ? source.allowNonMusic : fallback.allowNonMusic,
    minimumSubscribers: Math.round(boundedNumber(source.minimumSubscribers, 0, 1000000000, fallback.minimumSubscribers)),
    minimumViews: Math.round(boundedNumber(source.minimumViews, 0, 1000000000, fallback.minimumViews)),
    minimumConfidence: boundedNumber(source.minimumConfidence, 0.1, 0.95, fallback.minimumConfidence),
    derivatives: Object.fromEntries(DERIVATIVE_KINDS.map(kind => [
      kind,
      typeof sourceDerivatives[kind] === "boolean" ? sourceDerivatives[kind] : currentDerivatives[kind] !== false
    ]))
  };
}

module.exports = { DEFAULT_CATALOG_POLICY, DERIVATIVE_KINDS, catalogPolicyFrom };
