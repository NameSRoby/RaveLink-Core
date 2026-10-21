/** Time-based output envelope, independent of the chosen artistic recipe.
 * It interpolates brightness only: palette colors and calibrated bounds remain
 * intact. Zero timing reproduces the mapper target exactly. Scene-only routes
 * bypass this envelope so theatre fades and native restoration keep their rules.
 */
const { perceptual } = require("./palette-math.cjs");
module.exports = function createOutputMotion() {
  const previous = new Map();
  return {
    render(key, frame, at, config) {
      if (!frame || frame.sceneNative) return frame;
      const last = previous.get(key),
        target = frame.brightness;
      const duration =
        config.interpretation === "musical" &&
        config.behaviors.loudnessBrightness &&
        !config.behaviors.steadyBrightness
          ? 0
          : target > (last?.brightness ?? target)
            ? config.behaviors.outputAttackMs
            : config.behaviors.outputReleaseMs;
      const amount =
        last && duration > 0
          ? last.brightness +
            (target - last.brightness) * (1 - Math.exp(-Math.max(0, at - last.at) / duration))
          : target;
      const brightness = Math.max(
        config.minimumBrightness,
        Math.min(config.maximumBrightness, amount),
      );
      const color = [frame.rgb.r, frame.rgb.g, frame.rgb.b];
      const rgb =
        last && config.behaviors.outputColorMs > 0
          ? perceptual(
              last.rgb,
              color,
              1 - Math.exp(-Math.max(0, at - last.at) / config.behaviors.outputColorMs),
            )
          : color;
      previous.set(key, { brightness, rgb, at });
      return {
        ...frame,
        brightness,
        rgb: Object.fromEntries(["r", "g", "b"].map((field, i) => [field, rgb[i]])),
      };
    },
  };
};
