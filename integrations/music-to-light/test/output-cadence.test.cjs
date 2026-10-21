const test = require("node:test"),
  assert = require("node:assert/strict");
const create = require("../output-cadence.cjs");
const { settings } = require("../mapping-settings.cjs");

test("quiet color travel keeps render resolution without requiring a strong attack", () => {
  const c = create([{ brand: "hue", entertainmentActive: true }, { brand: "wiz" }]);
  const config = settings({ outputHz: 16, outputRateMode: "adaptive" });
  const motion = {
    fresh: true,
    metrics: { level: 0.3, rise: 0, attack: false, attackStrength: 0, colorMotion: true },
  };
  for (let at = 0; at <= 3000; at += 20) assert.equal(c.rate(config, motion, at), 16);
  assert.equal(c.rate(config, { ...motion, fresh: false }, 3020), 2);
  assert.equal(c.fixtureRate({ brand: "hue" }, 16), 8);
  assert.equal(c.fixtureRate({ brand: "wiz" }, 50), 16);
});
test("adaptive pacing holds fast attacks without selecting another recipe", () => {
  const c = create(),
    config = settings({ outputHz: 8, outputRateMode: "adaptive" });
  const idle = { fresh: true, metrics: { attack: false, rise: 0, level: 0 } };
  assert.equal(c.rate(config, idle, 0), 2);
  assert.equal(
    c.rate(config, { fresh: true, metrics: { attack: true, rise: 0, level: 0.8 } }, 100),
    8,
  );
  assert.equal(c.rate(config, idle, 700), 8);
  assert.equal(c.rate(config, idle, 1000), 2);
  assert.equal(c.rate({ ...config, outputRateMode: "fixed" }, idle, 1200), 8);
});

test("sixteen-Hz adaptive output follows calibrated energy, rises and attacks", () => {
  const c = create(),
    config = settings({ outputHz: 16, outputRateMode: "adaptive" });
  const sample = (level, rise = 0, attack = false) => ({
    fresh: true,
    metrics: { level, rise, attack },
  });
  assert.equal(c.rate(config, sample(0), 0), 2);
  assert.equal(c.rate(config, sample(0.3), 100), 4);
  assert.equal(c.rate(config, sample(0.6), 200), 6);
  assert.equal(c.rate(config, sample(0.9), 300), 8);
  assert.equal(c.rate(config, sample(0.6, config.behaviors.rateRiseThreshold), 400), 12);
  assert.equal(c.rate(config, sample(0.8, config.behaviors.rateRiseThreshold * 2), 500), 16);
  assert.equal(c.rate(config, sample(0.3), 1000), 16);
  assert.equal(c.rate(config, sample(0.3), 1400), 4);
  assert.equal(c.rate(config, sample(0.7, 0, true), 1500), 16);
  assert.equal(c.rate(config, { fresh: false, metrics: sample(1).metrics }, 1510), 2);
  assert.equal(c.rate(config, { fresh: true, metrics: { level: NaN, rise: 0 } }, 1520), 2);
});

test("requested and transport limits cap all adaptive tiers", () => {
  const fixtures = [{ brand: "hue" }, { brand: "hue" }, { brand: "wiz" }];
  for (const outputHz of [2, 4, 6, 8, 12, 16]) {
    const c = create(fixtures),
      config = settings({ outputHz, outputRateMode: "adaptive" });
    assert.equal(
      c.rate(config, { fresh: true, metrics: { level: 1, rise: 1, attack: true } }, 0),
      outputHz,
    );
    assert.deepEqual(
      fixtures.map((f) => c.fixtureRate(f, outputHz)),
      [Math.min(outputHz, 4), Math.min(outputHz, 4), outputHz],
    );
  }
  assert.throws(() => settings({ outputHz: 32 }));
});
test("Hue traffic has an aggregate music budget while WiZ can run independently", () => {
  const fixtures = [{ brand: "hue" }, { brand: "hue" }, { brand: "wiz" }, { brand: "wiz" }];
  const c = create(fixtures);
  assert.deepEqual(
    fixtures.map((f) => c.fixtureRate(f, 8)),
    [4, 4, 8, 8],
  );
  assert.equal(
    fixtures.filter((f) => f.brand === "hue").reduce((n, f) => n + c.fixtureRate(f, 8), 0),
    8,
  );
  assert.ok(fixtures.every((f) => c.fixtureRate(f, 2) === 2));
});
