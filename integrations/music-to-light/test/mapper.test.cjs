const test = require("node:test");
const assert = require("node:assert/strict");
const createMapper = require("../mapper.cjs");
const { settings } = require("../mapping-settings.cjs");
function sample(frame, rms = 0.1, bands = [rms, rms, rms], onset = null) {
  return {
    endFrame: frame * 960,
    discontinuities: 0,
    rms,
    signal: rms === 0 ? "silent" : "signal",
    invalidSamples: 0,
    analysis: { valid: true, bandRms: bands, onset },
  };
}
function feed(mapper, start, count, rms, bands) {
  for (let i = start; i < start + count; i++) mapper.update(sample(i, rms, bands), i * 20);
  return mapper.render((start + count - 1) * 20);
}
module.exports = { sample };
test("fixed calibration preserves quiet/loud ordering without recoloring or adaptive gain", () => {
  const mapper = createMapper({
    palette: ["#225588"],
    intensity: 1,
    behaviors: { colorEnabled: false },
  });
  const quiet = feed(mapper, 1, 100, 0.001);
  const loud = feed(mapper, 101, 100, 0.4);
  const quietAgain = feed(mapper, 201, 300, 0.001);
  assert.ok(quiet.brightness < loud.brightness);
  assert.ok(Math.abs(quiet.brightness - quietAgain.brightness) < 0.5);
  assert.deepEqual(quiet.rgb, { r: 34, g: 85, b: 136 });
  assert.deepEqual(quiet.rgb, loud.rgb);
  assert.ok(loud.brightness <= 35);
});
test("fresh silence settles dim and steady; absent samples return no artistic intent", () => {
  const mapper = createMapper({
    palette: ["#ff0000", "#0000ff"],
    colorMode: "travel",
    colorSeconds: 2,
  });
  feed(mapper, 1, 100, 0.4);
  const silent = feed(mapper, 101, 150, 0);
  assert.equal(silent.brightness, 10);
  assert.equal(silent.quiet, true);
  assert.deepEqual(silent.rgb, { r: 255, g: 0, b: 0 });
  assert.equal(mapper.render(5000 + 251), null);
});
test("literal response is faster; all feels obey identical brightness bounds", () => {
  const literal = createMapper({ interpretation: "literal", intensity: 1 });
  const musical = createMapper({ interpretation: "musical", intensity: 1 });
  assert.ok(feed(literal, 1, 1, 0.5).brightness > feed(musical, 1, 1, 0.5).brightness);
  for (const feel of ["slow", "normal", "fast", "aggressive"]) {
    const m = createMapper({ feel, intensity: 1, minimumBrightness: 7, maximumBrightness: 22 });
    const high = feed(m, 1, 100, 4);
    assert.ok(high.brightness >= 7 && high.brightness <= 22);
    assert.equal(feed(m, 101, 100, 0).brightness, 7);
  }
});
test("Bands uses measured role energy, while unified ignores assignment", () => {
  const m = createMapper({
    preset: "bands",
    arrangement: "roles",
    colorMode: "fixed",
    behaviors: { colorEnabled: false },
    palette: ["#ff0000", "#00ff00", "#0000ff"],
    intensity: 1,
  });
  feed(m, 1, 100, 0.2, [0.2, 0.01, 0]);
  assert.ok(
    m.render(2000, { role: "low" }).brightness > m.render(2000, { role: "mid" }).brightness,
  );
  assert.ok(
    m.render(2000, { role: "mid" }).brightness > m.render(2000, { role: "high" }).brightness,
  );
  assert.deepEqual(m.render(2000, { role: "low" }).rgb, { r: 255, g: 0, b: 0 });
  assert.deepEqual(m.render(2000, { role: "mid" }).rgb, { r: 0, g: 255, b: 0 });
  assert.deepEqual(m.render(2000, { role: "high" }).rgb, { r: 0, g: 0, b: 255 });
  const unified = createMapper({ preset: "ambient", arrangement: "unified" });
  feed(unified, 1, 100, 0.2, [0.2, 0.001, 0]);
  assert.equal(
    unified.render(2000, { role: "low" }).brightness,
    unified.render(2000, { role: "high" }).brightness,
  );
});
test("onsets step color once; pulse polling does not re-trigger or manufacture tempo", () => {
  const m = createMapper({
    preset: "pulse",
    colorMode: "onsets",
    palette: ["#ff0000", "#0000ff"],
    behaviors: { colorBlendMs: 0 },
  });
  feed(m, 1, 100, 0.1);
  m.update(sample(101, 0.1, undefined, { id: 1, detectedAtFrame: 101 * 960, strength: 0.2 }), 2020);
  const first = m.render(2020);
  assert.deepEqual(first.rgb, { r: 0, g: 0, b: 255 });
  assert.deepEqual(m.render(2100).rgb, first.rgb);
  assert.ok(m.render(2100).brightness <= first.brightness);
  assert.equal(
    m.render(2250, { onsetSince: 2000 }).brightness,
    first.brightness,
    "a new attack survives until the next scheduled output slot",
  );
  assert.ok(
    m.render(2250, { onsetSince: 2200 }).brightness < first.brightness,
    "the same attack is not retriggered in later slots",
  );
  assert.throws(
    () => m.update(sample(102, 0.1, undefined, { id: 1, detectedAtFrame: 102 * 960 }), 2040),
    /music_onset_replayed/,
  );
});
test("travel interpolation and spatial offsets are deterministic and preserve endpoints", () => {
  const m = createMapper({
    colorMode: "travel",
    arrangement: "spatial",
    palette: ["#000000", "#ffffff"],
    colorSeconds: 2,
  });
  m.update(sample(1), 20);
  assert.deepEqual(m.render(20, { position: 0 }).rgb, { r: 0, g: 0, b: 0 });
  assert.deepEqual(m.render(20, { position: 1 }).rgb, { r: 255, g: 255, b: 255 });
  const middle = m.render(20, { position: 0.5 }).rgb;
  assert.equal(middle.r, 188);
  assert.deepEqual(middle, { r: 188, g: 188, b: 188 });
});
test("invalid edits retain the working design and exports contain artistic settings only", () => {
  const m = createMapper({ palette: ["#123456"], preset: "pulse" });
  const saved = m.settings();
  saved.palette[0] = "#ffffff";
  for (const invalid of [
    { source: "default-output" },
    { maximumBrightness: 200 },
    { palette: [] },
    { feel: "__proto__" },
    { floorDb: -30, ceilingDb: -25 },
  ])
    assert.throws(() => m.configure(invalid), /invalid_music_settings/);
  assert.equal(m.settings().preset, "pulse");
  assert.equal(m.settings().palette[0], "#123456");
  assert.equal(new Set(m.settings().palette).size, 2);
  assert.deepEqual(settings(JSON.parse(JSON.stringify(m.settings()))), m.settings());
});

test("Pulse reserves attack headroom even in loud passages instead of clipping its steady bed", () => {
  const m = createMapper({ preset: "pulse", intensity: 1, colorMode: "fixed" });
  const bed = feed(m, 1, 100, 1).brightness;
  m.update(sample(101, 1, undefined, { id: 1, detectedAtFrame: 96960, strength: 0.2 }), 2020);
  const attack = m.render(2020).brightness;
  assert.ok(attack > bed + 5);
  assert.ok(attack <= 35);
  const settled = feed(m, 102, 150, 1).brightness;
  assert.ok(
    Math.abs(settled - bed) < 0.1,
    "no free-running beat survives after the measured attack",
  );
});

test("spatial placement spans the complete palette rather than just its first interval", () => {
  const m = createMapper({
    arrangement: "spatial",
    colorMode: "travel",
    palette: ["#ff0000", "#00ff00", "#0000ff"],
  });
  m.update(sample(1), 20);
  assert.deepEqual(m.render(20, { position: 0 }).rgb, { r: 255, g: 0, b: 0 });
  assert.deepEqual(m.render(20, { position: 0.5 }).rgb, { r: 0, g: 255, b: 0 });
  assert.deepEqual(m.render(20, { position: 1 }).rgb, { r: 0, g: 0, b: 255 });
});

test("Pulse makes an audible attack distinct from the sustained bed at four-Hz output", () => {
  const m = createMapper({ preset: "pulse", intensity: 1, colorMode: "fixed" });
  const bed = feed(m, 1, 150, 0.04).brightness;
  m.update(sample(151, 0.04, undefined, { id: 1, detectedAtFrame: 144960 }), 3020);
  feed(m, 152, 11, 0.04);
  const attack = m.render(3240, { onsetSince: 3000 }).brightness;
  assert.ok(attack - bed > 8, "attack must survive transport sampling with visible contrast");
  const after = feed(m, 163, 100, 0.04).brightness;
  assert.ok(Math.abs(after - bed) < 0.1, "sustained audio does not manufacture more attacks");
});

test("Bands emphasizes movement in its own band without cross-band pulses", () => {
  const m = createMapper({
    preset: "bands",
    arrangement: "roles",
    intensity: 1,
    behaviors: { bandSeparation: 1 },
  });
  feed(m, 1, 200, 0.1, [0.01, 0.02, 0.01]);
  const before = ["low", "mid", "high"].map((role) => m.render(4000, { role }).brightness);
  for (let i = 201; i <= 205; i++) m.update(sample(i, 0.1, [0.1, 0.02, 0.01]), i * 20);
  const after = ["low", "mid", "high"].map((role) => m.render(4100, { role }).brightness);
  assert.ok(after[0] - before[0] > 8);
  assert.ok(Math.abs(after[1] - before[1]) < 0.1);
  assert.ok(Math.abs(after[2] - before[2]) < 0.1);
});

test("a discontinuity discards old pulse and band-motion history", () => {
  const m = createMapper({ preset: "pulse", intensity: 1 });
  feed(m, 1, 100, 0.1);
  m.update(sample(101, 0.1, undefined, { id: 1, detectedAtFrame: 96960 }), 2020);
  const restarted = { ...sample(102, 0.1), discontinuities: 1 };
  m.update(restarted, 2040);
  const clean = createMapper({ preset: "pulse", intensity: 1 });
  clean.update(restarted, 2040);
  assert.equal(m.render(2040).brightness, clean.render(2040).brightness);
});

test("musical band balance reveals measured treble without promoting quiet audio or absent bands", () => {
  const musical = createMapper({
    preset: "bands",
    interpretation: "musical",
    intensity: 1,
    maximumBrightness: 60,
  });
  const raw = createMapper({
    preset: "bands",
    interpretation: "literal",
    intensity: 1,
    maximumBrightness: 60,
  });
  feed(musical, 1, 200, 0.05, [0.04, 0.02, 0.004]);
  feed(raw, 1, 200, 0.05, [0.04, 0.02, 0.004]);
  assert.ok(
    musical.render(4000, { role: "high" }).brightness >
      raw.render(4000, { role: "high" }).brightness + 1,
  );
  feed(musical, 201, 250, 0.003, [0, 0, 0.003]);
  assert.ok(
    musical.render(9000, { role: "high" }).brightness < 10.01,
    "overall quiet gate wins over treble trim",
  );
  assert.ok(musical.render(9000, { role: "low" }).brightness < 10.01, "no invented bass activity");
});

test("Bands exposes quiet measured treble while the full mix controls its ceiling", () => {
  const m = createMapper({
    preset: "bands",
    intensity: 1,
    arrangement: "roles",
    behaviors: { bandSeparation: 1 },
  });
  feed(m, 1, 250, 0.04, [0.03, 0.02, 0.002]);
  assert.ok(
    m.render(5000, { role: "high" }).brightness > 13,
    "treble below the absolute full-mix floor must remain visible",
  );
  feed(m, 251, 250, 0.04, [0.03, 0.02, 0]);
  assert.ok(
    m.render(10000, { role: "high" }).brightness < 10.01,
    "sensitivity cannot invent an absent band",
  );
  feed(m, 501, 250, 0.001, [0.001, 0.001, 0.001]);
  assert.ok(m.render(15000, { role: "low" }).brightness < 10.01);
});

test("Ambient fixed contrast expands passages without changing its response over time", () => {
  const response = (contrast, rms) => {
    const m = createMapper({
      preset: "ambient",
      arrangement: "unified",
      intensity: 1,
      behaviors: { ambientContrast: contrast },
    });
    return feed(m, 1, 500, rms).brightness;
  };
  const rmsAt = (level) => 10 ** ((-42 + level * 24) / 20);
  const originalSpan = response(1, rmsAt(0.7)) - response(1, rmsAt(0.3));
  const contrastedSpan = response(2, rmsAt(0.7)) - response(2, rmsAt(0.3));
  assert.ok(contrastedSpan > originalSpan * 1.5);
  assert.ok(response(2, 0.001) < 10.01);
  const m = createMapper({ preset: "ambient", intensity: 1, arrangement: "unified" });
  const first = feed(m, 1, 500, 0.025).brightness;
  feed(m, 501, 500, 0.2);
  const again = feed(m, 1001, 500, 0.025).brightness;
  assert.ok(Math.abs(first - again) < 0.01, "no song-dependent gain or curve changes");
});
