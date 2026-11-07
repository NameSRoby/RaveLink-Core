/** Short, loud rises can reach the measured target promptly. Small variations
 * retain the operator's smoothing. There is no pulse, peak hold or added gain.
 */
const clamp = (n) => Math.max(0, Math.min(1, n));
module.exports = function riseDuration(current, target, duration) {
  const contrast = clamp(((target - current) / Math.max(0.08, target) - 0.12) / 0.3);
  const audible = clamp((target - 0.04) / 0.2);
  const amount = contrast * contrast * (3 - 2 * contrast) * audible;
  return duration + (Math.min(duration, 20) - duration) * amount;
};
