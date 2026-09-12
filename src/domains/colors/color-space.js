// [TITLE] Module: domains/colors/color-space.js
// [TITLE] Purpose: color conversion + brand payload construction helpers
// [TITLE] Functionality Index:
// [TITLE] - HEX/RGB/HSV normalization and conversion
// [TITLE] - RGB -> CIE XY projection for Hue-compatible payloads
// [TITLE] - brand-specific state shaping for Hue/WiZ emitters

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function normalizeHex(hex) {
  const raw = String(hex || "").trim().toLowerCase();
  if (!/^#?[0-9a-f]{6}$/.test(raw)) return "";
  return raw.startsWith("#") ? raw : `#${raw}`;
}

function hexToRgb(hex) {
  const safe = normalizeHex(hex);
  if (!safe) return null;
  return {
    r: parseInt(safe.slice(1, 3), 16),
    g: parseInt(safe.slice(3, 5), 16),
    b: parseInt(safe.slice(5, 7), 16)
  };
}

function rgbToHex(rgb = {}) {
  const r = clampInt(rgb.r, 0, 255, 0);
  const g = clampInt(rgb.g, 0, 255, 0);
  const b = clampInt(rgb.b, 0, 255, 0);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

function rgbToXy(rRaw, gRaw, bRaw) {
  // [DEV] Conversion constants match a common Hue-compatible RGB -> XYZ matrix.
  // [DEV] Keep this deterministic because slight matrix drift changes perceived color.
  let r = clampInt(rRaw, 0, 255, 0) / 255;
  let g = clampInt(gRaw, 0, 255, 0) / 255;
  let b = clampInt(bRaw, 0, 255, 0) / 255;

  r = r > 0.04045 ? Math.pow((r + 0.055) / 1.055, 2.4) : r / 12.92;
  g = g > 0.04045 ? Math.pow((g + 0.055) / 1.055, 2.4) : g / 12.92;
  b = b > 0.04045 ? Math.pow((b + 0.055) / 1.055, 2.4) : b / 12.92;

  const X = r * 0.664511 + g * 0.154324 + b * 0.162028;
  const Y = r * 0.283881 + g * 0.668433 + b * 0.047685;
  const Z = r * 0.000088 + g * 0.07231 + b * 0.986039;

  const sum = X + Y + Z;
  if (sum <= 0) return [0, 0];
  return [X / sum, Y / sum];
}

function hsvToRgb255(hRaw, sRaw, vRaw) {
  // [DEV] HSV conversion is used by random color directives to keep
  // [DEV] cross-brand random generation in a single canonical function.
  const h = ((Number(hRaw) % 360) + 360) % 360;
  const s = Math.max(0, Math.min(1, Number(sRaw)));
  const v = Math.max(0, Math.min(1, Number(vRaw)));

  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;

  if (h < 60) {
    r1 = c; g1 = x; b1 = 0;
  } else if (h < 120) {
    r1 = x; g1 = c; b1 = 0;
  } else if (h < 180) {
    r1 = 0; g1 = c; b1 = x;
  } else if (h < 240) {
    r1 = 0; g1 = x; b1 = c;
  } else if (h < 300) {
    r1 = x; g1 = 0; b1 = c;
  } else {
    r1 = c; g1 = 0; b1 = x;
  }

  return {
    r: clampInt((r1 + m) * 255, 0, 255, 0),
    g: clampInt((g1 + m) * 255, 0, 255, 0),
    b: clampInt((b1 + m) * 255, 0, 255, 0)
  };
}

function createHueStateFromRgb(rgb = {}, options = {}) {
  const brightness = clampInt(options.brightness, 1, 254, 254);
  const transitiontime = clampInt(options.transitiontime, 0, 30, 2);
  const [x, y] = rgbToXy(rgb.r, rgb.g, rgb.b);
  return {
    on: true,
    xy: [x, y],
    bri: brightness,
    transitiontime
  };
}

function createHueStateWhite(options = {}) {
  const brightness = clampInt(options.brightness, 1, 254, 254);
  const transitiontime = clampInt(options.transitiontime, 0, 30, 2);
  return {
    on: true,
    ct: 366,
    bri: brightness,
    transitiontime
  };
}

function createWizStateFromRgb(rgb = {}, options = {}) {
  const dimming = clampInt(options.dimming, 1, 100, 100);
  return {
    on: true,
    r: clampInt(rgb.r, 0, 255, 0),
    g: clampInt(rgb.g, 0, 255, 0),
    b: clampInt(rgb.b, 0, 255, 0),
    dimming
  };
}

function createWizStateWhite(options = {}) {
  const dimming = clampInt(options.dimming, 1, 100, 100);
  return {
    on: true,
    r: 255,
    g: 255,
    b: 255,
    dimming
  };
}

module.exports = {
  normalizeHex,
  hexToRgb,
  rgbToHex,
  rgbToXy,
  hsvToRgb255,
  createHueStateFromRgb,
  createHueStateWhite,
  createWizStateFromRgb,
  createWizStateWhite
};
