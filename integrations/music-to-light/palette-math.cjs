/** Palette interpolation only. Oklab/OKLCH operates on color coordinates, never
 * the separate fixture brightness command. Gamut mapping reduces chroma at fixed
 * lightness/hue; it is not a claim of equal physical output between bulb colors.
 */
const clamp = (v) => Math.max(0, Math.min(1, v));
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const decode = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const encode = (v) =>
  Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
function hsv(color) {
  const [r, g, b] = color.map((n) => n / 255),
    max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    delta = max - min;
  let h = 0;
  if (delta)
    h =
      max === r ? ((g - b) / delta + 6) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return [h / 6, max ? delta / max : 0, max];
}
function fromHsv([h, s, v]) {
  const sector = h * 6,
    c = v * s,
    x = c * (1 - Math.abs((sector % 2) - 1)),
    m = v - c;
  return [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ][Math.floor(sector) % 6].map((n) => Math.round((n + m) * 255));
}
function oklch(color) {
  const [r, g, b] = color.map(decode);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const light = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const axis = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [light, Math.hypot(a, axis), Math.atan2(axis, a)];
}
function linear([light, chroma, hue]) {
  const a = chroma * Math.cos(hue),
    b = chroma * Math.sin(hue);
  const l = (light + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (light - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (light - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}
function perceptual(a, b, t) {
  if (t <= 0) return [...a];
  if (t >= 1) return [...b];
  const from = oklch(a),
    to = oklch(b),
    tau = 2 * Math.PI;
  // Near-neutral endpoints have no useful hue; borrow the chromatic endpoint.
  if (from[1] < 1e-6) from[2] = to[2];
  if (to[1] < 1e-6) to[2] = from[2];
  const arc = ((to[2] - from[2] + 3 * Math.PI) % tau) - Math.PI;
  const light = from[0] + (to[0] - from[0]) * t,
    hue = from[2] + arc * t;
  const chroma = from[1] + (to[1] - from[1]) * t;
  return fromOklch([light, chroma, hue]);
}
function fromOklch([light, chroma, hue]) {
  const valid = (values) => values.every((v) => v >= -1e-7 && v <= 1 + 1e-7);
  let result = linear([light, chroma, hue]);
  if (!valid(result)) {
    let low = 0,
      high = chroma;
    for (let i = 0; i < 14; i++) {
      const middle = (low + high) / 2;
      if (valid(linear([light, middle, hue]))) low = middle;
      else high = middle;
    }
    result = linear([light, low, hue]);
  }
  return result.map((v) => encode(clamp(v)));
}
function blend(a, b, t, vibrance = 0, expressive = false) {
  if (expressive) return perceptual(a, b, clamp(t));
  const result = a.map((v, i) => encode(decode(v) * (1 - t) + decode(b[i]) * t));
  if (!vibrance) return result;
  const from = hsv(a),
    to = hsv(b);
  if (!from[1]) from[0] = to[0];
  if (!to[1]) to[0] = from[0];
  const arc = ((to[0] - from[0] + 1.5) % 1) - 0.5;
  const vivid = fromHsv([
    (from[0] + arc * t + 1) % 1,
    from[1] + (to[1] - from[1]) * t,
    from[2] + (to[2] - from[2]) * t,
  ]);
  return result.map((n, i) => Math.round(n + (vivid[i] - n) * vibrance));
}
module.exports = { rgb, hsv, fromHsv, blend, oklch, perceptual, fromOklch };
