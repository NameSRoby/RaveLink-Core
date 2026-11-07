/** Color timing follows the fixed calibrated energy reference. Rise promptly;
 * settle gradually through short dips. Never learns gain from a quiet passage.
 */
const clamp = (n) => Math.max(0, Math.min(1, n));
module.exports = function createColorReactivity() {
  let energy = 0,
    loudness = 0,
    clock = 0,
    attacks = [];
  return {
    update(level, delta, pace = 1, detail = {}) {
      loudness +=
        (clamp(level) - loudness) * (1 - Math.exp((-delta * pace) / (level > loudness ? 60 : 140)));
      clock += delta;
      attacks = attacks.filter((at) => clock - at <= 1200);
      if (level > 0.01 && detail.attack) attacks.push(clock);
      if (attacks.length > 16) attacks.shift();
      const density = attacks.length >= 3 ? clamp((attacks.length - 1) / 3) : 0;
      const novelty =
        level > 0.01 && Number.isFinite(detail.novelty) ? clamp(detail.novelty) * 0.8 : 0;
      const audibleWeight = Math.sqrt(clamp(level));
      const target = clamp(Math.max(level, density * audibleWeight, novelty * audibleWeight)),
        duration = target > energy ? 100 : 600;
      energy += (target - energy) * (1 - Math.exp((-delta * pace) / duration));
    },
    timing(minimumBlendMs = 60, pace = 1) {
      const activity = 1 - (1 - energy) * (1 - energy);
      return {
        energy,
        loudness,
        intervalMs: (1000 - 850 * activity) / pace,
        blendMs: Math.max(minimumBlendMs, (360 - 300 * activity) / pace),
      };
    },
    reset() {
      energy = 0;
      loudness = 0;
      clock = 0;
      attacks = [];
    },
  };
};
