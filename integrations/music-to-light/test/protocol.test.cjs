const test = require("node:test");
const assert = require("node:assert/strict");
const { createLines, createProtocol, source, validateSource } = require("../protocol.cjs");
const generation = "a".repeat(32);
const ready = {
  v: 2,
  type: "ready",
  generation,
  signal: "waiting",
  format: {
    encoding: "f32le",
    sample_rate: 48000,
    channels: 2,
    frame_bytes: 8,
    window_frames: 960,
    analysis: {
      fft_size: 2048,
      hop_frames: 960,
      band_edges_hz: [20, 250, 4000, 20000],
      window: "hann",
      flux: "positive_magnitude_difference",
      onset_refractory_frames: 5760,
    },
  },
};
const hello = { v: 2, type: "hello", generation, scope: "process_tree", max_seconds: 1 };
const measurement = () => ({
  v: 2,
  type: "level",
  generation,
  sample_rate: 48000,
  level: {
    first_frame: 0,
    end_frame: 960,
    rms: 0,
    peak: 0,
    dbfs: null,
    channel_rms: [0, 0],
    invalid_samples: 0,
    clipped_samples: 0,
    signal: "silent",
    analysis: null,
  },
  qpc_end_100ns: "12345",
  discontinuities: 0,
});
function running() {
  const consume = createProtocol({ generation, scope: "process_tree", seconds: 1 });
  consume(hello);
  consume(ready);
  return consume;
}

test("NDJSON delivery preserves Unicode and records at every byte split", () => {
  const expected = [{ label: "音楽 🎵" }, { signal: "silent", analysis: null }];
  const bytes = Buffer.from(expected.map((e) => JSON.stringify(e) + "\n").join(""));
  for (let size = 1; size <= bytes.length; size++) {
    const received = [],
      parser = createLines((e) => received.push(e));
    for (let i = 0; i < bytes.length; i += size) parser.push(bytes.subarray(i, i + size));
    parser.finish();
    assert.deepEqual(received, expected);
  }
});
test("oversized, malformed, invalid UTF8 and truncated lines fail closed", () => {
  assert.throws(() => createLines(() => {}, 8).push(Buffer.from("123456789")), /too_large/);
  assert.throws(() => createLines(() => {}).push(Buffer.from("{bad}\n")), /invalid_json/);
  assert.throws(() => createLines(() => {}).push(Buffer.from([34, 255, 34, 10])), /invalid_json/);
  const parser = createLines(() => {});
  parser.push(Buffer.from('{"v":2}'));
  assert.throws(() => parser.finish(), /truncated/);
});
test("source scope is explicit and PID identity uses exact integer text", () => {
  assert.equal(source("process:123:132456789012345678"), "process_tree");
  assert.equal(source("default-output"), "entire_endpoint");
  for (const value of [
    "auto",
    "",
    "TIDAL",
    "process:0:123",
    "process:5:0",
    "process:5:18446744073709551616",
    "output:",
    "output:bad\npath",
  ])
    assert.throws(() => source(value), /invalid_source/);
  assert.deepEqual(
    validateSource({
      id: "process:1:2",
      label: "Player.exe",
      kind: "application",
      scope: "process_tree",
      executablePath: "private",
    }),
    { id: "process:1:2", label: "Player.exe", kind: "application", scope: "process_tree" },
  );
});
test("readiness is not signal; missing data is distinct from measured zero", () => {
  const consume = running();
  assert.equal(
    consume({ v: 2, type: "status", generation, signal: "waiting", last_sample_age_ms: null })
      .signal,
    "waiting",
  );
  assert.equal(consume(measurement()).signal, "silent");
  assert.equal(
    consume({ v: 2, type: "status", generation, signal: "stale", last_sample_age_ms: 900 }).signal,
    "stale",
  );
});
test("wrong format, stale generations and data before readiness are rejected", () => {
  assert.throws(
    () => createProtocol({ generation, scope: "process_tree", seconds: 1 })(measurement()),
    /not_ready/,
  );
  const consume = createProtocol({ generation, scope: "process_tree", seconds: 1 });
  consume(hello);
  assert.throws(
    () => consume({ ...ready, format: { ...ready.format, channels: 1 } }),
    /format_mismatch/,
  );
  assert.throws(
    () => running()({ ...measurement(), generation: "b".repeat(32) }),
    /stale_generation/,
  );
  assert.throws(
    () =>
      createProtocol({ generation, scope: "process_tree", seconds: 1 })({
        ...hello,
        scope: "entire_endpoint",
      }),
    /scope_mismatch/,
  );
});
test("unaccounted sample gaps, invalid measurements and data after end are rejected", () => {
  const consume = running();
  consume(measurement());
  assert.throws(() => consume(measurement()), /discontinuity/);
  const discontinuous = measurement();
  discontinuous.discontinuities = 1;
  assert.equal(consume(discontinuous).discontinuities, 1);
  const bad = measurement();
  bad.level.rms = Infinity;
  assert.throws(() => running()(bad), /invalid_measurement/);
  const inconsistent = measurement();
  inconsistent.level.rms = 0.5;
  assert.throws(() => running()(inconsistent), /invalid_measurement/);
  consume({
    v: 2,
    type: "ended",
    generation,
    reason: "duration",
    packets: 1,
    frames: 960,
    discontinuities: 1,
  });
  assert.throws(() => consume(measurement()), /after_end/);
});
module.exports = { ready, hello, measurement };

test("analysis has real units, bounded bands and unique onset events; old protocol requires rebuild", () => {
  const packet = measurement();
  packet.level.first_frame = 1920;
  packet.level.end_frame = 2880;
  packet.level.analysis = {
    first_frame: 832,
    end_frame: 2880,
    band_rms: [0.1, 0.2, 0.05],
    spectral_flux: 0.2,
    onset_threshold: 0.01,
    onset: { id: 1, detected_at_frame: 2880, strength: 0.2 },
    valid: true,
  };
  packet.level.bpm = 120;
  const consume = running(),
    event = consume(packet);
  assert.equal(event.analysis.onset.id, 1);
  assert.deepEqual(event.analysis.bandRms, [0.1, 0.2, 0.05]);
  assert.equal(event.bpm, undefined);
  packet.level.first_frame = 2880;
  packet.level.end_frame = 3840;
  packet.level.analysis.first_frame = 1792;
  packet.level.analysis.end_frame = 3840;
  packet.level.analysis.onset.detected_at_frame = 3840;
  assert.throws(() => consume(packet), /invalid_analysis/);
  const bad = measurement();
  bad.level.analysis = { ...packet.level.analysis, band_rms: [0.1, NaN, 0.2] };
  assert.throws(() => running()(bad), /invalid_analysis/);
  assert.throws(
    () => createProtocol({ generation, scope: "process_tree", seconds: 1 })({ ...hello, v: 1 }),
    /bad_version/,
  );
});

test("contradictory level units and fabricated nonzero/zero signal flags are rejected", () => {
  const flag = measurement();
  flag.level.signal = "signal";
  assert.throws(() => running()(flag), /invalid_measurement/);
  const contradictory = measurement();
  Object.assign(contradictory.level, {
    rms: 0.5,
    peak: 0.4,
    dbfs: -6.020599913,
    channel_rms: [0.5, 0.5],
    signal: "signal",
  });
  assert.throws(() => running()(contradictory), /invalid_measurement/);
  contradictory.level.peak = 0.6;
  contradictory.level.dbfs = -30;
  assert.throws(() => running()(contradictory), /invalid_measurement/);
});
