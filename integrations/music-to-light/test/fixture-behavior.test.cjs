const test = require("node:test"),
  assert = require("node:assert/strict");
const { sceneFrame, validate } = require("../fixture-behavior.cjs");
const { settings } = require("../mapping-settings.cjs");
const config = settings({ maximumBrightness: 60, palette: ["#ff0000", "#00ff00", "#0000ff"] });
const frame = {
  brightness: 55,
  rgb: { r: 200, g: 0, b: 100 },
  sampledAt: 1,
  role: "all",
  quiet: false,
};
test("theatre dim preserves color, fades monotonically and cannot brighten an off/dim light", () => {
  const fixture = { brand: "hue", raveBehavior: "dim", sceneBrightness: 10, sceneFadeMs: 2000 };
  const baseline = { on: true, bri: 152, ct: 350 };
  const frames = [0, 500, 1000, 1500, 2000, 4000].map((t) =>
    sceneFrame(fixture, frame, config, baseline, t),
  );
  for (let i = 1; i < frames.length; i++)
    assert.ok(frames[i].brightness <= frames[i - 1].brightness);
  assert.ok(Math.abs(frames.at(-1).brightness - 10) < 0.01);
  assert.equal(frames.at(-1).sceneNative.bri, 25);
  assert.ok(!Object.hasOwn(frames[1].sceneNative, "xy"));
  assert.ok(!Object.hasOwn(frames[1].sceneNative, "ct"));
  assert.deepEqual(sceneFrame(fixture, frame, config, { on: false, bri: 152 }, 1000).sceneNative, {
    on: false,
  });
  assert.equal(sceneFrame(fixture, frame, config, { on: true, bri: 1 }, 2000).sceneNative.bri, 1);
});
test("scene roles ignore audio, honor brightness caps and retain requested palette slots", () => {
  const fixture = { brand: "wiz", raveBehavior: "steady", sceneBrightness: 90, colorSlot: 1 };
  const a = sceneFrame(fixture, frame, config, { on: true, dimming: 50 }, 0),
    b = sceneFrame(
      fixture,
      { ...frame, brightness: 11, rgb: { r: 0, g: 0, b: 0 } },
      config,
      { on: true, dimming: 50 },
      1000,
    );
  assert.equal(a.brightness, 60);
  assert.deepEqual(a.rgb, { r: 0, g: 255, b: 0 });
  assert.equal(b.brightness, a.brightness);
  assert.deepEqual(b.rgb, a.rgb);
  assert.deepEqual(
    sceneFrame({ ...fixture, raveBehavior: "off" }, frame, config, {}, 0).sceneNative,
    { on: false },
  );
  assert.throws(() => validate({ raveBehavior: "desktop" }), /invalid_music_fixture_behavior/);
  assert.throws(() => validate({ sceneFadeMs: Infinity }), /invalid_music_fixture_behavior/);
});
