/** A sustained loudness foundation, independent of onset detection and render
 * timing. Accents briefly move above or below it; a spatial mask or missing
 * drum cannot extinguish the foundation. No learned gain or automatic reference.
 */
module.exports = function createLoudnessBody() {
  let levels = [0, 0, 0, 0],
    directions = [1, 1, 1, 1],
    impactDirections = [1, 1, 1, 1];
  return {
    update(index, target, delta, behaviors, onset = false, impactWins = onset) {
      const previous = levels[index];
      const duration = target > previous ? behaviors.bodyAttackMs : behaviors.bodyReleaseMs;
      levels[index] += (target - previous) * (1 - Math.exp(-delta / duration));
      // Choose once per measured attack. Moving loudness cannot reverse a
      // pulse halfway through its recovery. Below the crossover an upward
      // accent fits; above it a dip keeps the full transient visible.
      if (onset) {
        directions[index] =
          levels[index] * (1 + Math.max(behaviors.accentDepth, behaviors.impactDepth)) <= 1
            ? 1
            : -1;
        if (impactWins) impactDirections[index] = directions[index];
      }
    },
    mix(index, accent, behaviors, impact = null, energy = 1) {
      const level = levels[index],
        depth = behaviors.accentDepth,
        extra = impact === null ? 0 : Math.max(0, behaviors.impactDepth - depth),
        ordinary = depth * Math.max(0, Math.min(level, accent)),
        strong =
          extra * Math.max(0, Math.min(level, energy)) * Math.max(0, Math.min(1, impact || 0));
      return Math.max(
        0,
        Math.min(1, level + directions[index] * ordinary + impactDirections[index] * strong),
      );
    },
    reset() {
      levels = [0, 0, 0, 0];
      directions = [1, 1, 1, 1];
      impactDirections = [1, 1, 1, 1];
    },
  };
};
