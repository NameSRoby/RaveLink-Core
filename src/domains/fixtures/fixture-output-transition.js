/** Restoration choreography only. Source and destination are already-owned
 * native states, never client-supplied colors. Brightness and color interpolate
 * separately. Incompatible white/color modes cross at a dim midpoint; the final
 * restore operation remains authoritative for native modes and off-state data.
 * This is not audio and must not be labelled as fresh measured music.
 */
const clamp = (v) => Math.max(0, Math.min(1, v));
function ease(value) {
  const t = clamp(value);
  return t * t * t * (t * (t * 6 - 15) + 10);
}
function mode(state) {
  if (state.sceneId > 0) return "scene";
  if (state.temp || state.ct) return "white";
  if (state.xy) return "xy";
  if (state.r !== undefined) return "rgb";
  if (state.hue !== undefined) return "hsv";
  return "brightness";
}
function interpolate(from, to, progress) {
  if (progress <= 0) return structuredClone(from);
  if (progress >= 1) return structuredClone(to);
  const t = ease(progress),
    key = "bri" in to || "bri" in from ? "bri" : "dimming";
  const floor = key === "bri" ? 1 : 10;
  const start = from.on === false ? 0 : Number(from[key] ?? to[key] ?? floor);
  const target = to.on === false ? 0 : Number(to[key] ?? start);
  const compatible = mode(from) === mode(to) && mode(to) !== "scene";
  const base = compatible || t >= 0.5 || from.on === false ? to : from;
  const state = structuredClone(base);
  state.on = start > 0 || target > 0;
  state[key] = Math.max(
    floor,
    Math.round(
      compatible || from.on === false || to.on === false
        ? start + (target - start) * t
        : t < 0.5
          ? start * (1 - 2 * t)
          : target * (2 * t - 1),
    ),
  );
  if (compatible) {
    for (const field of ["r", "g", "b", "ct", "temp", "sat", "hue"])
      if (Number.isFinite(from[field]) && Number.isFinite(to[field]))
        state[field] = Math.round(from[field] + (to[field] - from[field]) * t);
    if (from.xy && to.xy) state.xy = from.xy.map((v, i) => v + (to.xy[i] - v) * t);
  }
  if (key === "bri") state.transitiontime = 0;
  return state;
}
module.exports = { interpolate, ease };
