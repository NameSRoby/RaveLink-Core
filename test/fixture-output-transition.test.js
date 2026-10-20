const test = require("node:test"),
  assert = require("node:assert/strict");
const { interpolate } = require("../src/domains/fixtures/fixture-output-transition");
const normalize = require("../src/domains/fixtures/fixture-output-state");
test("return curves preserve exact endpoints and valid native white/color/off modes", () => {
  const states = [
    { on: false, bri: 100, ct: 350 },
    { on: true, bri: 180, xy: [0.6, 0.3] },
    { on: true, dimming: 30, temp: 2700 },
    { on: true, dimming: 80, r: 255, g: 5, b: 70 },
    { on: true, dimming: 35, sceneId: 4, speed: 20 },
  ];
  for (const from of states)
    for (const to of states) {
      // Hue and WiZ live in separate native lanes; never blend cross-brand data.
      if (Object.hasOwn(from, "bri") !== Object.hasOwn(to, "bri")) continue;
      assert.deepEqual(interpolate(from, to, 0), from);
      assert.deepEqual(interpolate(from, to, 1), to);
      for (let t = 0.01; t < 1; t += 0.01)
        assert.doesNotThrow(() => normalize(interpolate(from, to, t)));
    }
});
