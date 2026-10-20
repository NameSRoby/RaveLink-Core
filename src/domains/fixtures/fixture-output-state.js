/** Bounded native light state, kept inside the server. Baselines must preserve
 * off/white/native-scene modes; credentials and arbitrary adapter metadata never
 * belong in them. Colors and dimming remain independent fields.
 */
const ranges = Object.freeze({
  bri: [0, 254],
  hue: [0, 65535],
  sat: [0, 254],
  ct: [1, 1000],
  dimming: [0, 100],
  temp: [1000, 10000],
  r: [0, 255],
  g: [0, 255],
  b: [0, 255],
  transitiontime: [0, 65535],
  sceneId: [0, 1000],
  speed: [0, 255],
});
module.exports = function fixtureOutputState(value, baseline = false) {
  const invalid = () => {
    throw Object.assign(new Error("invalid_fixture_output_state"), {
      code: "invalid_fixture_output_state",
    });
  };
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 20)
    return invalid();
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (["on", "__forceRest", "__entertainment"].includes(key)) {
      if (typeof item !== "boolean") return invalid();
      result[key] = item;
    } else if (Object.hasOwn(ranges, key)) {
      const [min, max] = ranges[key];
      if (!Number.isFinite(item) || item < min || item > max) return invalid();
      result[key] = item;
    } else if (key === "xy") {
      if (
        !Array.isArray(item) ||
        item.length !== 2 ||
        item.some((v) => !Number.isFinite(v) || v < 0 || v > 1)
      )
        return invalid();
      result.xy = [...item];
    } else if (key === "__rgb") {
      if (
        !item ||
        Object.keys(item).length !== 3 ||
        ["r", "g", "b"].some((c) => !Number.isFinite(item[c]) || item[c] < 0 || item[c] > 255)
      )
        return invalid();
      result.__rgb = { r: item.r, g: item.g, b: item.b };
    } else if (key === "effect" && ["none", "colorloop"].includes(item)) result.effect = item;
    else if (key === "alert" && ["none", "select", "lselect"].includes(item)) result.alert = item;
    else return invalid();
  }
  if (!Object.keys(result).length || (baseline && typeof result.on !== "boolean")) return invalid();
  return result;
};
