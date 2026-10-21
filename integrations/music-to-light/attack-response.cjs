/** Fixed response to measured onset salience. No learned gain, invented beats,
 * tempo inference or transport-specific amplification. Missing analysis retains
 * the reference response; verified expressive analysis earns its accent size.
 */
const clamp = (value) => Math.max(0, Math.min(1, value));
module.exports = function createAttackResponse() {
  let at = -Infinity,
    strength = 0,
    peak = 0,
    impactPeak = 0,
    latestImpact = 0;
  const weights = new Map(),
    impacts = new Map();
  return {
    accept(onset, threshold, expressive, time, decay) {
      const measured =
        expressive &&
        Number.isFinite(onset.strength) &&
        Number.isFinite(threshold) &&
        threshold >= 0;
      // The detector already requires mean + three deviations and a refractory
      // interval. Distance above that adaptive threshold is not musical
      // importance: a regular kick can barely exceed it. Preserve a visible
      // accent for every accepted event; excess novelty only adds headroom.
      const margin = measured
        ? clamp((2 * (onset.strength - threshold)) / Math.max(1e-9, onset.strength + threshold))
        : 1;
      const next = measured ? 0.35 + 0.65 * margin : 1;
      // Additional impact is selective; ordinary qualified events still keep
      // their regular pulse and color movement. Missing analysis earns no impact.
      const impact = measured ? clamp((margin - 0.6) / 0.4) : 0;
      const nextImpact = impact * impact * (3 - 2 * impact);
      latestImpact = nextImpact;
      impactPeak = Math.max(nextImpact, impactPeak * Math.exp(-Math.max(0, time - at) / decay));
      peak = Math.max(next, peak * Math.exp(-Math.max(0, time - at) / decay));
      at = time;
      strength = next;
      weights.set(time, next);
      impacts.set(time, nextImpact);
      return next;
    },
    level(time, decay) {
      return peak * Math.exp(-Math.max(0, time - at) / decay);
    },
    activity(time) {
      return strength * Math.exp(-Math.max(0, time - at) / 120);
    },
    impact(time, decay, since) {
      let value = impactPeak * Math.exp(-Math.max(0, time - at) / decay);
      if (Number.isFinite(since))
        for (const [at, strength] of impacts)
          if (at > since && at <= time) value = Math.max(value, strength);
      return value;
    },
    latest: () => strength,
    latestImpact: () => latestImpact,
    weight: (time) => weights.get(time) || 0,
    retain(times) {
      const keep = new Set(times);
      for (const time of weights.keys()) if (!keep.has(time)) weights.delete(time);
      for (const time of impacts.keys()) if (!keep.has(time)) impacts.delete(time);
    },
    reset() {
      at = -Infinity;
      strength = peak = impactPeak = latestImpact = 0;
      weights.clear();
      impacts.clear();
    },
  };
};
