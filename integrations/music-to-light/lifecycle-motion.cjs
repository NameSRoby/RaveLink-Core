/** Opening choreography in normalized fixture positions, not guessed geometry.
 * Raised-cosine spots and quintic crossfades have zero end velocity. A single
 * deterministic opening gives way to the already-locked measured recipe; it
 * never redraws the recipe or adds artificial attacks. Scene roles bypass it.
 */
const { perceptual, rgb: parse } = require("./palette-math.cjs");
const clamp = (v) => Math.max(0, Math.min(1, v));
const ease = (v) => {
  const t = clamp(v);
  return t * t * t * (t * (t * 6 - 15) + 10);
};
function choose(behaviors, random = Math.random, history = null) {
  function pick(key, count) {
    if (behaviors[key] !== count + 1) return behaviors[key];
    if (history)
      return Number(
        history.draw(
          "lifecycle:" + key,
          Array.from({ length: count }, (_, i) => ({ id: String(i + 1), weight: 1 })),
          random,
        ).id,
      );
    const roll = random();
    if (!Number.isFinite(roll) || roll < 0 || roll >= 1) throw Error("invalid_music_random");
    return 1 + Math.floor(roll * count);
  }
  return Object.freeze({
    openingStyle: pick("openingStyle", 3),
    endingStyle: pick("endingStyle", 2),
    openingMs: behaviors.openingMs,
    endingMs: behaviors.endingMs,
  });
}
function opening(frame, fixture, config, elapsed, baseline, plan = config.behaviors) {
  const style = plan.openingStyle,
    duration = plan.openingMs;
  if (
    !style ||
    !duration ||
    elapsed >= duration ||
    frame.sceneNative ||
    (fixture.raveBehavior && fixture.raveBehavior !== "reactive")
  )
    return frame;
  const t = clamp(elapsed / duration),
    position = clamp(fixture.position ?? 0.5);
  // Never start by turning on a non-reactive fixture. For reactive fixtures,
  // start from the acquired brightness, clamped to this session's light limits.
  const initial =
    baseline?.on === false
      ? 0
      : fixture.brand === "hue"
        ? Number(baseline?.bri) / 2.54
        : Number(baseline?.dimming);
  const start = Number.isFinite(initial)
    ? Math.max(0, Math.min(config.maximumBrightness, initial))
    : config.minimumBrightness;
  const progress = clamp(t / 0.72);
  const center = style === 3 ? (1 - Math.cos(progress * Math.PI * 2)) / 2 : progress;
  const distance = Math.min(1, Math.abs(position - center) / 0.55);
  const spot =
    style === 2 ? Math.sin(Math.PI * progress) ** 2 : (1 + Math.cos(Math.PI * distance)) / 2;
  const rise = ease(t / 0.18);
  const accent =
    config.minimumBrightness + (config.maximumBrightness - config.minimumBrightness) * spot * 0.7;
  const staged = start + (accent - start) * rise;
  const blend = ease((t - 0.6) / 0.4);
  const palette = config.palette;
  const phase = ((position + progress) % 1) * palette.length;
  const a = palette[Math.floor(phase)],
    b = palette[(Math.floor(phase) + 1) % palette.length];
  const color = perceptual(parse(a), parse(b), phase % 1);
  const rgb = perceptual(color, [frame.rgb.r, frame.rgb.g, frame.rgb.b], blend);
  return {
    ...frame,
    rgb: Object.fromEntries(["r", "g", "b"].map((k, i) => [k, rgb[i]])),
    brightness: staged + (frame.brightness - staged) * blend,
    entranceMix: rise,
  };
}
module.exports = { opening, ease, choose };
