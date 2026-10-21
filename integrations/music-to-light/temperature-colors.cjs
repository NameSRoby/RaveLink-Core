/** Musical color temperature, not a bulb's white-temperature command. Raw band
 * proportions are smoothed before calibration can clip them all to the ceiling.
 */
const { hsv, blend } = require("./palette-math.cjs");
function family(rgb) {
  const [h, s] = hsv(rgb);
  if (s < 0.15) return "neutral";
  if (h < 0.18 || h >= 0.9) return "warm";
  if (h >= 0.45 && h < 0.85) return "cool";
  return "neutral";
}
function groups(palette) {
  const nearest = (hue) =>
    palette.reduce((a, b) => {
      const d = (rgb) => {
        const h = Math.abs(hsv(rgb)[0] - hue);
        return Math.min(h, 1 - h);
      };
      return d(a) <= d(b) ? a : b;
    });
  return ["warm", "cool"].map((kind, i) => {
    const stops = palette.filter((rgb) => family(rgb) === kind);
    return stops.length ? stops : [nearest(i ? 0.6 : 0.08)];
  });
}
function create() {
  let balance = 0.5;
  const api = {
    update(bands, delta) {
      if (!bands) return;
      const total = bands.reduce((sum, n) => sum + n, 0);
      if (total > 0)
        balance += ((bands[1] * 0.5 + bands[2]) / total - balance) * (1 - Math.exp(-delta / 160));
    },
    color(palette, role, sample, perceptual = true) {
      const [warm, cool] = groups(palette);
      const mix =
        role === "low" ? 0 : role === "high" ? 1 : role === "mid" ? 0.25 + 0.5 * balance : balance;
      return blend(sample(warm), sample(cool), mix, 1, perceptual);
    },
    map(palette, role, source, perceptual = true) {
      return api.color(
        palette,
        role,
        (stops) => {
          const phase = hsv(source)[0] * stops.length;
          const index = Math.floor(phase) % stops.length;
          return blend(stops[index], stops[(index + 1) % stops.length], phase % 1, 1, perceptual);
        },
        perceptual,
      );
    },
    reset() {
      balance = 0.5;
    },
  };
  return api;
}
module.exports = { create, family, groups };
