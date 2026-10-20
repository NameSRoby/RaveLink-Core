/** Pure dynamic-effect command parsing. No timers, fixture access or output.
 * Keep palette validation and compatibility aliases here so scheduling/ownership
 * changes cannot silently change the accepted chat language.
 */
const { hsvToRgb255 } = require("../colors/color-space");
const EFFECTS = new Set([
  "cycle",
  "fade",
  "breathe",
  "rainbow",
  "wave",
  "sweep",
  "ripple",
  "chase",
  "rave",
]);
const SPEEDS = Object.freeze({ fast: 1200, normal: 2400, slow: 4500 });
const RAINBOW = Object.freeze([0, 45, 90, 150, 210, 270, 315].map((hue) => hsvToRgb255(hue, 1, 1)));
function rgbFromHex(value) {
  const match = /^#([0-9a-f]{6})$/i.exec(String(value || ""));
  return match
    ? {
        r: parseInt(match[1].slice(0, 2), 16),
        g: parseInt(match[1].slice(2, 4), 16),
        b: parseInt(match[1].slice(4, 6), 16),
      }
    : null;
}
module.exports = function createLightEffectCommand(directiveService) {
  function parse(rawText) {
    const source = String(rawText || "")
      .replace(/\s+/g, " ")
      .trim();
    const requested = /^([a-z]+)(?:\s+|$)/i.exec(source)?.[1]?.toLowerCase() || "";
    const first = requested === "alternate" ? "cycle" : requested;
    if (/^rave\s+stop$/i.test(source))
      return { matched: true, ok: true, type: "stop", raveOnly: true };
    if (first === "stop" && /^(?:stop|stop\s+(?:effects?|lights?))$/i.test(source))
      return { matched: true, ok: true, type: "stop" };
    if (!EFFECTS.has(first)) return { matched: false };
    let remainder = source.slice(requested.length).trim(),
      speed = "normal";
    const speedMatch = /(?:^|\s)(fast|slow|normal|aggressive)$/i.exec(remainder);
    if (speedMatch) {
      speed = speedMatch[1].toLowerCase();
      remainder = remainder.slice(0, speedMatch.index).trim();
    }
    if (speed === "aggressive" && first !== "rave")
      return { matched: true, ok: false, error: "effect_speed_invalid" };
    let colors = [];
    if (first === "rainbow") {
      if (remainder)
        return {
          matched: true,
          ok: false,
          error: "rainbow_accepts_only_an_optional_speed",
        };
      colors = RAINBOW.map((row) => ({ ...row }));
    } else {
      if (!remainder && first === "rave") colors = [];
      else if (!remainder && first === "wave") colors = RAINBOW.map((row) => ({ ...row }));
      else {
        const tokens = remainder
          .split(/\s*,\s*/)
          .map((row) => row.trim())
          .filter(Boolean);
        const minimum = ["breathe", "rave"].includes(first) ? 1 : 2;
        if (
          tokens.length < minimum ||
          tokens.length > (first === "rave" ? 8 : 12) ||
          (requested === "alternate" && tokens.length !== 2) ||
          (first === "breathe" && tokens.length !== 1)
        ) {
          return {
            matched: true,
            ok: false,
            error:
              requested === "alternate"
                ? "alternate_requires_exactly_two_colors"
                : first === "breathe"
                  ? "breathe_requires_one_color"
                  : "effect_requires_2_to_12_colors",
          };
        }
        for (const token of tokens) {
          const parsed = directiveService.parseTwitchColorDirective(token);
          const rgb = parsed.ok ? rgbFromHex(parsed.hex) : null;
          if (!rgb)
            return {
              matched: true,
              ok: false,
              error: `invalid_effect_color:${token}`,
            };
          colors.push(rgb);
        }
      }
    }
    return {
      matched: true,
      ok: true,
      type: first,
      speed,
      durationMs: SPEEDS[speed],
      colors,
      ...(requested === "alternate" ? { compatibilityAlias: "alternate" } : {}),
    };
  }

  return parse;
};
module.exports.supportedCommands = Object.freeze([...EFFECTS, "stop"]);
