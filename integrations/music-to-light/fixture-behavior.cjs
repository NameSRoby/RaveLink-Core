/** Trusted per-fixture scene intent. Non-reactive roles share Rave ownership,
 * lifetime and restoration, but never derive their brightness from audio.
 * Dimming only reduces acquired starting brightness and preserves color.
 * An already-off fixture stays off. Baselines never reach the browser.
 */
const fault = () =>
  Object.assign(Error("invalid_music_fixture_behavior"), {
    code: "invalid_music_fixture_behavior",
  });
function validate(row) {
  if (
    row.raveBehavior !== undefined &&
    !["reactive", "dim", "steady", "off"].includes(row.raveBehavior)
  )
    throw fault();
  for (const [key, min, max] of [
    ["sceneBrightness", 1, 100],
    ["sceneFadeMs", 0, 10000],
    ["colorSlot", 0, 7],
    ["outOfSync", 0, 100],
  ])
    if (row[key] !== undefined && (!Number.isInteger(row[key]) || row[key] < min || row[key] > max))
      throw fault();
  return row;
}
function sceneFrame(fixture, frame, config, baseline, elapsed) {
  const behavior = fixture.raveBehavior || "reactive";
  if (behavior === "reactive") return frame;
  const slot = fixture.colorSlot || 0,
    hex = config.palette[slot % config.palette.length];
  const rgb = Object.fromEntries(
    ["r", "g", "b"].map((k, i) => [k, parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16)]),
  );
  if (behavior === "off") return { ...frame, brightness: 0, sceneNative: { on: false } };
  const level = Math.min(
    config.maximumBrightness,
    Math.max(fixture.brand === "wiz" ? 10 : 1, fixture.sceneBrightness ?? 10),
  );
  if (behavior === "steady") return { ...frame, rgb, brightness: level };
  const on = baseline?.on !== false && baseline?.state !== false;
  if (!on) return { ...frame, brightness: 0, sceneNative: { on: false } };
  const start =
    fixture.brand === "hue" ? (Number(baseline?.bri) * 100) / 254 : Number(baseline?.dimming);
  if (!Number.isFinite(start))
    throw Object.assign(Error("music_scene_baseline_unavailable"), {
      code: "music_scene_baseline_unavailable",
    });
  const target = Math.min(start, level),
    fade = fixture.sceneFadeMs ?? 1500;
  const t = fade ? Math.max(0, Math.min(1, elapsed / fade)) : 1;
  const brightness = on
    ? Math.min(config.maximumBrightness, start + (target - start) * t * t * (3 - 2 * t))
    : 0;
  const native = !on
    ? { on: false }
    : fixture.brand === "hue"
      ? { on: true, bri: Math.max(1, Math.round((brightness * 254) / 100)), transitiontime: 0 }
      : { on: true, dimming: Math.max(fixture.brand === "wiz" ? 10 : 1, Math.round(brightness)) };
  return { ...frame, brightness, sceneNative: native };
}
module.exports = { validate, sceneFrame };
