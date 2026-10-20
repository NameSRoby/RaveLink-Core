/** Convert getPilot to a setPilot state, preserving off/white/scene modes.
 * Network replies use `state`; internal writes use `on`. Never infer an off
 * bulb is on just because the internal spelling is absent from the reply.
 */
module.exports = function restorableWizState(raw) {
  if (typeof raw?.state !== "boolean") return null;
  const value = { on: raw.state };
  if (Number.isInteger(raw.dimming)) {
    if (raw.dimming < 1 || raw.dimming > 100) return null;
    value.dimming = raw.dimming;
  }
  if (Number.isInteger(raw.sceneId) && raw.sceneId > 0 && raw.sceneId <= 1000) {
    value.sceneId = raw.sceneId;
    if (Number.isInteger(raw.speed)) value.speed = raw.speed;
  } else if (Number.isFinite(raw.temp) && raw.temp > 0) value.temp = raw.temp;
  else if ([raw.r, raw.g, raw.b].every(Number.isFinite))
    Object.assign(value, { r: raw.r, g: raw.g, b: raw.b });
  return value;
};
