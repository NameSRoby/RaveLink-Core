const test = require("node:test");
const assert = require("node:assert/strict");
const rise = require("../brightness-response.cjs");
const create = require("../mapper.cjs");
const direct = require("../direct-brightness-settings.cjs");
const { settings } = require("../mapping-settings.cjs");
const accepted = require("../profiles/accepted-color-led-v1.json");

test("only large audible rises accelerate the selected attack", () => {
  assert.equal(rise(0.6, 0.68, 120), 120);
  assert.equal(rise(0.01, 0.04, 120), 120);
  assert.equal(rise(0.1, 0.4, 120), 20, "quieter genuine impacts must respond promptly too");
  assert.equal(rise(0.4, 1, 120), 20);
  assert.equal(rise(0.4, 1, 5), 5);
  for (let i = 0; i <= 100; i++) {
    const duration = rise(i / 100, 1, 120);
    assert(duration >= 20 && duration <= 120);
  }
});

function fixture() {
  const design = settings(
    direct(
      settings({
        ...accepted,
        intensity: 0.75,
        minimumBrightness: 10,
        maximumBrightness: 90,
        floorDb: -44,
        ceilingDb: -20,
      }),
    ),
  );
  const mapper = create(design);
  let frame = 0;
  return {
    feed(level, count = 1, onset = false) {
      let output;
      for (let i = 0; i < count; i++) {
        frame++;
        const rms =
          level === 0
            ? 0
            : Math.sqrt(10 ** (-44 / 10) + level * (10 ** (-20 / 10) - 10 ** (-44 / 10)));
        mapper.update(
          {
            endFrame: frame * 960,
            discontinuities: 0,
            rms,
            invalidSamples: 0,
            signal: rms ? "signal" : "silent",
            analysis: {
              valid: true,
              bandRms: [rms * 0.8, rms * 0.3, rms * 0.1],
              onsetThreshold: 1,
              spectralFlux: onset && i === 0 ? 2 : 0,
              onset:
                onset && i === 0 ? { id: frame, detectedAtFrame: frame * 960, strength: 2 } : null,
            },
          },
          frame * 20,
        );
        output = mapper.render(frame * 20);
      }
      return output;
    },
    inspect: () => mapper.inspect(frame * 20),
    at: () => frame * 20,
    since: (at) => mapper.render(frame * 20, { energySince: at }),
  };
}

test("short loud impacts reach the range promptly and settle to the sustained sound", () => {
  const m = fixture();
  assert(Math.abs(m.feed(0.4, 300).brightness - 40.656) < 0.001);
  assert(m.feed(1, 2, true).brightness > 75, "a 40 ms impact must survive smoothing");
  const held = m.feed(0.4, 300).brightness;
  assert(Math.abs(held - 40.656) < 0.001, "sustained sound must not fall into an imposed trough");
  assert(
    Math.abs(m.feed(1, 300).brightness - 90) < 0.001,
    "legacy intensity cannot cap native output",
  );
  assert.equal(m.feed(0, 300).brightness, 10);
});

test("mild contrast separates softer and stronger levels without moving the midpoint or limits", () => {
  const m = fixture();
  assert(m.feed(0.2, 300).brightness < 26);
  assert(Math.abs(m.feed(0.5, 300).brightness - 50) < 0.001);
  assert(m.feed(0.8, 300).brightness > 74);
  assert(Math.abs(m.feed(1, 300).brightness - 90) < 0.001);
});

test("a short measured peak survives one output slot and cannot replay after consumption", () => {
  const m = fixture();
  m.feed(0.3, 100);
  const start = m.at();
  m.feed(1);
  const current = m.feed(0.2, 3);
  const retained = m.since(start);
  assert(retained.brightness > current.brightness + 10);
  const consumed = m.at();
  const next = m.feed(0.2);
  assert.equal(m.since(consumed).brightness, next.brightness);
  m.feed(0.2, 20);
  assert(
    m.since(start).brightness < retained.brightness - 20,
    "old peaks must age out instead of becoming a backlog",
  );
});

test("small fluctuations retain the accepted smoothing exactly", () => {
  const m = fixture();
  m.feed(0.65, 300);
  let expected = m.inspect().metrics.level;
  for (let i = 0; i < 300; i++) {
    const level = 0.65 + 0.025 * Math.sin(i * 0.6);
    expected +=
      (level - expected) *
      (1 -
        Math.exp(
          -20 /
            (level > expected
              ? accepted.behaviors.literalAttackMs
              : accepted.behaviors.literalReleaseMs),
        ));
    m.feed(level);
    assert(Math.abs(m.inspect().metrics.level - expected) < 1e-9);
  }
});

test("a growing three-hit buildup gains brightness while colors advance on every measured hit", () => {
  const m = fixture(),
    withoutOnsets = fixture();
  const peaks = [],
    changes = [];
  for (const level of [0.65, 0.82, 1]) {
    m.feed(0.3, 40);
    withoutOnsets.feed(0.3, 40);
    const hit = m.feed(level, 2, true);
    const plain = withoutOnsets.feed(level, 2);
    assert.equal(hit.brightness, plain.brightness, "brightness must follow measured energy alone");
    peaks.push(hit.brightness);
    changes.push(m.inspect().metrics.colorChangeAt);
  }
  assert(peaks[0] < peaks[1] && peaks[1] < peaks[2]);
  for (let i = 0; i < 150; i++) m.feed(0.95, 1, i % 8 === 0);
  assert.equal(new Set(changes).size, 3, "quiet hits must advance colors too");
  assert.equal(m.inspect().metrics.colorIntervalMs, 120);
  assert(m.inspect().metrics.colorChangeAt > 0);
});
