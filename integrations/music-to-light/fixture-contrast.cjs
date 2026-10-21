/** Fixture diversity from the current audio only: no delayed samples, invented
 * beats or free-running brightness oscillators. Zero preserves the reference.
 */
const clamp = (v) => Math.max(0, Math.min(1, v));
function plan(fixtures) {
  const active = fixtures.filter((f) => !f.raveBehavior || f.raveBehavior === "reactive");
  return fixtures.map((f) => ({
    ...f,
    contrastSlot: (active.indexOf(f) + 1) / (active.length + 1),
  }));
}
function amount(value, { percent, slot, level, bands, attack }) {
  if (!percent || level <= 0) return value;
  const blend = clamp((percent / 100 - 0.35) / 0.65);
  const band = bands[Math.min(2, Math.floor(slot * 3))] || 0;
  // Frequency emphasis occupies at most 15% of the current measured response.
  const body = value * (1 - 0.15 * blend * (1 - clamp(band / Math.max(0.001, level))));
  const depth = 0.2 * clamp((percent / 100 - 0.65) / 0.35);
  const accent = depth * Math.min(value, level) * clamp(attack);
  return clamp(body + (slot < 0.5 ? accent : -accent));
}
module.exports = { plan, amount };
