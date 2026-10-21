const test = require("node:test"),
  assert = require("node:assert/strict");
const createMapper = require("../mapper.cjs");
function mapper(overrides = {}) {
  return createMapper({
    preset: "pulse",
    intensity: 1,
    minimumBrightness: 10,
    maximumBrightness: 100,
    floorDb: -47,
    ceilingDb: -23,
    colorMode: "onsets",
    ...overrides,
    behaviors: {
      expressiveEnabled: true,
      loudnessBrightness: true,
      accentDepth: 0.18,
      impactDepth: 0.18,
      pulseBed: 0.4,
      pulseDecayMs: 160,
      ...overrides.behaviors,
    },
  });
}
function update(m, i, db, hit = false, discontinuities = 0) {
  const rms = db === -Infinity ? 0 : 10 ** (db / 20);
  const onset = hit
    ? { id: i, detectedAtFrame: i * 960, strength: typeof hit === "number" ? hit : 3 }
    : null;
  m.update(
    {
      endFrame: i * 960,
      discontinuities,
      rms,
      signal: rms ? "signal" : "silent",
      invalidSamples: 0,
      analysis: {
        valid: true,
        bandRms: [rms * 0.8, rms * 0.4, rms * 0.1],
        logOnset: onset,
        logOnsetThreshold: 1,
        logSpectralFlux: hit ? 3 : 0.1,
      },
    },
    i * 20,
  );
  return m.render(i * 20);
}
test("sustained loud music stays bright without drums; drums occupy only the reserved accent range", () => {
  const plain = mapper(),
    drums = mapper();
  const brightness = [],
    colors = new Set();
  for (let i = 1; i <= 400; i++) {
    const a = update(plain, i, -23),
      b = update(drums, i, -23, i % 20 === 0);
    if (i > 100) {
      assert(a.brightness >= 83, "missing onsets cannot dim a loud sustained passage");
      assert(Math.abs(b.brightness - a.brightness) <= 90 * 0.18 + 1e-8);
      brightness.push(b.brightness);
      colors.add(JSON.stringify(b.rgb));
    }
  }
  assert(Math.max(...brightness) - Math.min(...brightness) < 17);
  assert(colors.size > 100, "color continues responding while brightness persists");
});
test("sustained brightness follows absolute loudness and settles through quiet gaps", () => {
  const quiet = mapper(),
    medium = mapper(),
    loud = mapper();
  let q, m, l;
  for (let i = 1; i <= 150; i++) {
    q = update(quiet, i, -41);
    m = update(medium, i, -32);
    l = update(loud, i, -23);
  }
  assert(q.brightness < m.brightness && m.brightness < l.brightness);
  const afterGap = update(loud, 151, -Infinity);
  assert(afterGap.brightness > 65, "one silent window must not blink the room off");
  for (let i = 152; i <= 180; i++) l = update(loud, i, -Infinity);
  assert(
    l.brightness < 25,
    "a genuinely quiet passage falls promptly without retaining the old attack",
  );
  for (let i = 181; i <= 210; i++) l = update(loud, i, -Infinity);
  assert.equal(l.brightness, 10);
  assert.equal(l.quiet, true);
});
test("spatial masks cannot extinguish the loudness foundation; literal rendering remains independent", () => {
  const spatial = mapper({
    recipeOptions: { shape: { mode: "fixed", value: "wave", allowed: ["wave"] } },
  });
  for (let i = 1; i <= 150; i++) update(spatial, i, -23, i % 20 === 0);
  for (const position of [0, 0.25, 0.5, 0.75, 1])
    assert(spatial.render(3000, { position }).brightness >= 83);
  const literalA = mapper({ interpretation: "literal" });
  const literalB = mapper({ interpretation: "literal", behaviors: { loudnessBrightness: false } });
  for (let i = 1; i <= 100; i++)
    assert.deepEqual(
      update(literalA, i, i % 30 < 10 ? -40 : -25),
      update(literalB, i, i % 30 < 10 ? -40 : -25),
    );
});
test("zero regular and strong pulse depth keeps loudness motion but removes onset brightness changes", () => {
  const a = mapper({ behaviors: { accentDepth: 0, impactDepth: 0 } }),
    b = mapper({ behaviors: { accentDepth: 0, impactDepth: 0 } });
  for (let i = 1; i <= 200; i++) {
    const db = i < 100 ? -35 : -23;
    assert.equal(update(a, i, db).brightness, update(b, i, db, i % 10 === 0).brightness);
  }
  const before = a.render(4000);
  for (let i = 0; i < 100; i++) assert.deepEqual(a.render(4000), before);
  const restarted = update(a, 201, -40, false, 1);
  assert(restarted.brightness < 20, "discontinuity cannot retain an old loud foundation");
});

test("strong attacks make meaningful dips at the ceiling while ordinary attacks stay small", () => {
  const weak = mapper({ behaviors: { accentDepth: 0.1, impactDepth: 0.35 } });
  const strong = mapper({ behaviors: { accentDepth: 0.1, impactDepth: 0.35 } });
  for (let i = 1; i <= 150; i++) {
    update(weak, i, -23);
    update(strong, i, -23);
  }
  assert(
    weak.render(3000).brightness > 99,
    "no permanent headroom is subtracted from the foundation",
  );
  const small = update(weak, 151, -23, 1.02),
    big = update(strong, 151, -23, 3);
  assert(small.brightness > 94);
  assert(big.brightness < 75 && big.brightness > 65);
  let recovered;
  for (let i = 152; i <= 191; i++) recovered = update(strong, i, -23);
  assert(recovered.brightness > 99, "the dip returns to the unchanged loudness foundation");
});
test("strong attacks pulse upward at lower levels without turning quiet music into a full flash", () => {
  const m = mapper({ behaviors: { accentDepth: 0.1, impactDepth: 0.35 } });
  for (let i = 1; i <= 150; i++) update(m, i, -41);
  const before = m.render(3000).brightness,
    hit = update(m, 151, -41, 3);
  assert(hit.brightness > before + 5);
  assert(hit.brightness < 45);
});
test("pulse direction is latched at onset and cannot reverse during a loudness change", () => {
  const body = require("../loudness-body.cjs")();
  const b = { bodyAttackMs: 120, bodyReleaseMs: 300, accentDepth: 0.1, impactDepth: 0.35 };
  for (let i = 0; i < 100; i++) body.update(0, 0.6, 20, b);
  body.update(0, 0.6, 20, b, true);
  for (let i = 0; i < 15; i++) {
    body.update(0, 1, 20, b);
    assert(body.mix(0, 0.5, b, 0.5) >= body.mix(0, 0, b, 0));
  }
  body.update(0, 1, 20, b, true);
  assert(body.mix(0, 0.5, b, 0.5) < body.mix(0, 0, b, 0));
});

test("a weak new onset cannot reverse the tail of an earlier strong dip", () => {
  const body = require("../loudness-body.cjs")();
  const b = { bodyAttackMs: 120, bodyReleaseMs: 300, accentDepth: 0.1, impactDepth: 0.35 };
  for (let i = 0; i < 100; i++) body.update(0, 1, 20, b);
  body.update(0, 1, 20, b, true, true);
  for (let i = 0; i < 15; i++) body.update(0, 0.5, 20, b);
  body.update(0, 0.5, 20, b, true, false);
  assert(body.mix(0, 0, b, 0.5) < body.mix(0, 0, b, 0));
});

test("every loudness-foundation preset retains measured drum accents without replacing its sustained body", () => {
  for (const preset of ["ambient", "bands", "pulse"]) {
    for (const position of [0, 0.5, 1]) {
      const plain = mapper({ preset, behaviors: { accentDepth: 0.1, impactDepth: 0.35 } });
      const drums = mapper({ preset, behaviors: { accentDepth: 0.1, impactDepth: 0.35 } });
      for (let i = 1; i <= 150; i++) {
        update(plain, i, -23);
        update(drums, i, -23);
      }
      update(plain, 151, -23);
      update(drums, 151, -23, 3);
      const a = plain.render(3020, { position }),
        b = drums.render(3020, { position });
      assert(
        Math.abs(a.brightness - b.brightness) > 8,
        `${preset} must retain a strong measured drum`,
      );
      assert(Math.abs(a.brightness - b.brightness) <= 31.500001);
      const snapshot = drums.render(3020, { position });
      assert.deepEqual(drums.render(3020, { position }), snapshot);
      for (let i = 152; i <= 230; i++) {
        update(plain, i, -23);
        update(drums, i, -23);
      }
      assert(
        Math.abs(
          plain.render(4600, { position }).brightness - drums.render(4600, { position }).brightness,
        ) < 0.1,
      );
    }
  }
});

test("band-wave and wash recipes cannot erase strong pulses; disabled attacks and zero depth remain deliberate", () => {
  for (const preset of ["ambient", "bands"])
    for (const behaviors of [{ attacksEnabled: false }, { accentDepth: 0, impactDepth: 0 }]) {
      const a = mapper({ preset, behaviors }),
        b = mapper({ preset, behaviors });
      for (let i = 1; i <= 150; i++) {
        update(a, i, -23);
        update(b, i, -23);
      }
      assert.equal(update(a, 151, -23).brightness, update(b, 151, -23, 3).brightness);
    }
  const a = mapper({
    preset: "bands",
    recipeOptions: { shape: { mode: "fixed", value: "wave", allowed: ["wave"] } },
    behaviors: { accentDepth: 0.1, impactDepth: 0.35 },
  });
  for (let i = 1; i <= 150; i++) update(a, i, -23);
  const before = a.render(3000).brightness;
  update(a, 151, -23, 3);
  assert(Math.abs(a.render(3020).brightness - before) > 15);
});

test("expressive continuous color choices respond to audio events rather than only elapsed time", () => {
  for (const colorMode of ["fixed", "roles", "travel", "energy"]) {
    const quiet = mapper({ colorMode }),
      drums = mapper({ colorMode });
    for (let i = 1; i <= 160; i++) {
      update(quiet, i, -30);
      update(drums, i, -30, i >= 120 && i % 10 === 0);
    }
    assert.notDeepEqual(quiet.render(3200).rgb, drums.render(3200).rgb, colorMode);
    const original = drums.render(3200);
    assert.deepEqual(drums.render(3200), original);
    for (let i = 161; i <= 270; i++) update(drums, i, -Infinity);
    assert.equal(drums.render(5400).quiet, true);
    assert.equal(drums.render(5700), null);
  }
});
