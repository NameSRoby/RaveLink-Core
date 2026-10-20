const test = require("node:test");
const assert = require("node:assert/strict");
const create = require("../mapper.cjs");
const looks = require("../looks.cjs");
const { simulate } = require("../simulation.cjs");
function event(i, rms = 0.05, bands = [0.04, 0.02, 0.005]) {
  return {
    endFrame: i * 960,
    discontinuities: 0,
    rms,
    signal: rms ? "signal" : "silent",
    invalidSamples: 0,
    analysis: { valid: true, bandRms: bands, onset: null },
  };
}
function feed(m, start, count, rms, bands) {
  for (let i = start; i < start + count; i++) m.update(event(i, rms, bands), i * 20);
  return (start + count - 1) * 20;
}

test("vivid blending keeps a chromatic hue arc without changing brightness", () => {
  const base = {
    preset: "pulse",
    arrangement: "spatial",
    colorMode: "travel",
    palette: ["#00ffff", "#ff00ff"],
  };
  const raw = create(base),
    vivid = create({ ...base, behaviors: { colorVibrance: 1 } });
  raw.update(event(1), 20);
  vivid.update(event(1), 20);
  const a = raw.render(20, { position: 0.5 }),
    b = vivid.render(20, { position: 0.5 });
  assert.deepEqual(b.rgb, { r: 0, g: 0, b: 255 });
  assert.ok(a.rgb.r > 100 && a.rgb.g > 100, "reference blend remains unchanged");
  assert.equal(a.brightness, b.brightness);
  assert.deepEqual(vivid.render(20, { position: 0 }).rgb, { r: 0, g: 255, b: 255 });
  assert.deepEqual(vivid.render(20, { position: 1 }).rgb, { r: 255, g: 0, b: 255 });
});

test("swell uses distinct fixture positions, halts in silence and resumes the same recipe", () => {
  const look = looks.find((l) => l.id === "aurora-swell");
  const m = create({ ...look.design, intensity: 1 });
  const at = feed(m, 1, 200, 0.06);
  const lights = [0, 1 / 3, 2 / 3, 1].map((position) => m.render(at, { position }));
  const brightness = lights.map((f) => f.brightness);
  assert.ok(Math.max(...brightness) - Math.min(...brightness) > 8);
  assert.ok(Math.abs(brightness[0] - brightness[3]) > 1, "route endpoints are not duplicated");
  feed(m, 201, 300, 0, [0, 0, 0]);
  const quiet = [0, 1 / 3, 2 / 3, 1].map((position) => m.render(10000, { position }));
  assert.ok(quiet.every((f) => f.brightness === 10 && f.quiet));
  assert.deepEqual(quiet[0].rgb, quiet[3].rgb, "silence settles to the same palette color");
  assert.equal(m.preset(), "ambient");
});

test("band competition creates contrast without inventing an absent band", () => {
  const design = { preset: "bands", intensity: 1, arrangement: "roles", colorMode: "fixed" };
  const broad = create({ ...design, behaviors: { bandSeparation: 1 } });
  const separated = create({ ...design, behaviors: { bandSeparation: 5 } });
  feed(broad, 1, 300, 0.06, [0.05, 0.015, 0]);
  feed(separated, 1, 300, 0.06, [0.05, 0.015, 0]);
  const contrast = (m) =>
    m.render(6000, { role: "low" }).brightness - m.render(6000, { role: "mid" }).brightness;
  assert.ok(contrast(separated) > contrast(broad) + 3);
  assert.ok(separated.render(6000, { role: "high" }).brightness < 10.01);
});

test("unassigned Bands fixtures receive measured position roles and require spectrum", () => {
  const m = create({
    preset: "bands",
    arrangement: "roles",
    colorMode: "fixed",
    palette: ["#ff0000", "#00ff00", "#0000ff"],
  });
  const first = event(1);
  delete first.analysis;
  m.update(first, 20);
  assert.equal(m.render(20, { role: "all", position: 1 }), null);
  feed(m, 2, 300, 0.06, [0.05, 0.015, 0]);
  assert.notDeepEqual(m.render(6020, { position: 0 }).rgb, { r: 255, g: 0, b: 0 });
  assert.notDeepEqual(m.render(6020, { position: 0 }).rgb, m.render(6020, { position: 1 }).rgb);
  assert(m.render(6020, { position: 0 }).brightness > m.render(6020, { position: 1 }).brightness);
});

test("every composition replays at bounded device cadence and native brightness resolution", () => {
  const features = Array.from({ length: 1000 }, (_, i) =>
    event(i + 1, i < 750 ? 0.05 : 0, i < 750 ? [0.04, 0.02, 0.005] : [0, 0, 0]),
  );
  const fixtures = [
    { brand: "hue", role: "low", position: 0 },
    { brand: "wiz", role: "high", position: 1 },
  ];
  for (const look of looks) {
    const frames = simulate({ features, fixtures, design: { ...look.design, intensity: 1 } });
    assert.ok(frames.length > 60);
    for (let i = 0; i < frames.length; i++) {
      if (i) assert.ok(frames[i].at - frames[i - 1].at >= 250);
      for (const [j, f] of frames[i].lights.entries()) {
        assert.ok(f.brightness >= 10 && f.brightness <= 35);
        assert.ok(Object.values(f.rgb).every((n) => Number.isInteger(n) && n >= 0 && n <= 255));
        const units = f.brightness * (fixtures[j].brand === "hue" ? 2.54 : 1);
        assert.ok(Math.abs(units - Math.round(units)) < 1e-8);
      }
    }
    assert.ok(frames.at(-1).lights.every((f) => f.brightness <= 10.24));
  }
});

test("simulation schedules sixteen-Hz render deadlines between twenty-ms analysis windows", () => {
  const features = Array.from({ length: 250 }, (_, i) => event(i + 1));
  const frames = simulate({
    features,
    fixtures: [{ brand: "hue", entertainmentActive: true, role: "all", position: 0 }],
    design: { outputHz: 16, outputRateMode: "fixed" },
  });
  assert.ok(frames.length >= 78 && frames.length <= 80, String(frames.length));
  for (let i = 1; i < frames.length; i++) assert.equal(frames[i].at - frames[i - 1].at, 62.5);
});
