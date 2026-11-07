/** Opening choreography in normalized fixture positions, not guessed geometry.
 * Raised-cosine spots and quintic crossfades have zero end velocity. A single
 * deterministic opening gives way to the already-locked measured recipe; it
 * never redraws the recipe or adds artificial attacks. Scene roles bypass it.
 */
const clamp = (v) => Math.max(0, Math.min(1, v));
const ease = (v) => {
  const t = clamp(v);
  return t * t * t * (t * (t * 6 - 15) + 10);
};
function choose(behaviors, random = Math.random, history = null) {
  function pick(key, values, randomValue) {
    if (behaviors[key] !== randomValue) return behaviors[key];
    if (history)
      return Number(
        history.draw(
          "lifecycle:" + key,
          values.map((value) => ({ id: String(value), weight: 1 })),
          random,
        ).id,
      );
    const roll = random();
    if (!Number.isFinite(roll) || roll < 0 || roll >= 1) throw Error("invalid_music_random");
    return values[Math.floor(roll * values.length)];
  }
  return Object.freeze({
    openingStyle: pick("openingStyle", [1, 2, 3], 4),
    endingStyle: pick("endingStyle", [1, 2, 4], 3),
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
  // Stagger the admission, not the music: no decorative brightness boost or
  // invented color cycle can overpower a quiet intro. Native output interpolates
  // from the acquired color/mode; the virtual preview illustrates brightness.
  const offset =
    0.35 * (style === 2 ? Math.abs(position * 2 - 1) : style === 3 ? 1 - position : position);
  const progress = clamp((t - offset) / (1 - offset));
  const mix = ease(progress);
  return {
    ...frame,
    brightness: start + (frame.brightness - start) * mix,
    entranceTargetBrightness: frame.brightness,
    entranceMix: progress,
  };
}
module.exports = { opening, ease, choose };
