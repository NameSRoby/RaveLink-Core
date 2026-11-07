/** Small target changes accumulate against confirmed output, never against the
 * previous sample. Power, native modes and transition semantics remain exact.
 */
const { isDeepStrictEqual } = require("node:util");
module.exports = function sameTarget(a, b) {
  if (!a || Object.keys(a).length !== Object.keys(b).length) return false;
  return Object.entries(b).every(([key, value]) => {
    if (!Object.hasOwn(a, key)) return false;
    if (key === "bri") return Math.abs(a[key] - value) < 2.54;
    if (key === "dimming") return Math.abs(a[key] - value) < 1;
    if (["r", "g", "b"].includes(key)) return Math.abs(a[key] - value) < 2;
    if (key === "__rgb") return ["r", "g", "b"].every((c) => Math.abs(a[key][c] - value[c]) < 2);
    if (key === "xy") return value.every((v, i) => Math.abs(a[key][i] - v) < 0.001);
    return isDeepStrictEqual(a[key], value);
  });
};
