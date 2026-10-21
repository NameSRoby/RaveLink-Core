/** Continuous palette travel from measured energy, novelty and band balance.
 * Onsets add bounded travel, not brightness or random palette replacements.
 * Rendering is read-only; fresh silent input cannot advance the color phase.
 */
const { blend } = require("./palette-math.cjs");
const clamp = (v, low = 0, high = 1) => Math.max(low, Math.min(high, v));
module.exports = function createMusicalColor() {
  let phase = 0,
    pending = 0,
    balance = null,
    reference = null,
    offset = 0;
  return {
    update({ delta, energy, bands, flux, threshold, strength, seconds, blendMs, motion }) {
      if (energy <= 0) {
        pending = 0;
        return;
      }
      const novelty =
        Number.isFinite(flux) && Number.isFinite(threshold)
          ? clamp(flux / Math.max(1e-9, flux + threshold))
          : 0;
      const amount = Math.sqrt(clamp(energy));
      const base = (amount * (0.8 + 2 * novelty) * motion) / seconds;
      pending = Math.min(1.5, pending + (strength > 0 ? 0.35 + 0.25 * strength : 0));
      const wanted = pending * (1 - Math.exp(-delta / Math.max(80, blendMs)));
      const maximum = amount * ((4 * motion) / seconds + 350 / Math.max(200, blendMs));
      const step = Math.min((base * delta) / 1000 + wanted, (maximum * delta) / 1000);
      phase += step;
      pending = Math.max(0, pending - Math.max(0, step - (base * delta) / 1000));
      if (bands?.length === 3) {
        const total = bands.reduce((sum, value) => sum + value, 0);
        const target = total > 0 ? (bands[1] * 0.5 + bands[2]) / total : 0;
        balance ??= target;
        reference ??= target;
        balance += (target - balance) * (1 - Math.exp(-delta / 160));
        reference += (balance - reference) * (1 - Math.exp(-delta / 1200));
        offset = 0.2 * amount * clamp(4 * (balance - reference), -1, 1);
      }
    },
    color(palette, slot = 0) {
      const position =
        (((phase + offset + slot) % palette.length) + palette.length) % palette.length;
      const index = Math.floor(position);
      return blend(
        palette[index],
        palette[(index + 1) % palette.length],
        position - index,
        1,
        true,
      );
    },
    reset() {
      phase = pending = offset = 0;
      balance = reference = null;
    },
  };
};
