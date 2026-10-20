/** Native probe boundary. Decode complete UTF-8 lines, validate measurements and
 * reject stale generations. No arbitrary helper fields enter client snapshots.
 * Protocol v2 includes verified bands/onsets and a private clock exchange.
 */
const { TextDecoder } = require("node:util");
const spectral = require("./analysis-protocol.cjs");
const integer = (v, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= 0 && v <= max;
const finite = (v, min, max) => Number.isFinite(v) && v >= min && v <= max;
const fail = (code) => Object.assign(new Error(code), { code });

function createLines(onLine, maxBytes = 8192) {
  let carry = Buffer.alloc(0);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return {
    push(chunk) {
      const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let offset = 0;
      while (offset < input.length) {
        const newline = input.indexOf(10, offset);
        const end = newline < 0 ? input.length : newline;
        if (carry.length + end - offset > maxBytes) throw fail("native_line_too_large");
        const line = Buffer.concat([carry, input.subarray(offset, end)]);
        carry = Buffer.alloc(0);
        if (newline < 0) {
          carry = line;
          break;
        }
        let value;
        try {
          value = JSON.parse(decoder.decode(line));
        } catch {
          throw fail("native_invalid_json");
        }
        onLine(value);
        offset = newline + 1;
      }
    },
    finish() {
      if (carry.length) throw fail("native_truncated_line");
    },
  };
}

function source(value) {
  if (typeof value !== "string" || value.length > 1100 || /[\x00-\x1f\x7f]/.test(value))
    throw fail("invalid_source");
  if (value === "fullscreen-app") return "process_tree";
  if (value === "default-output") return "entire_endpoint";
  if (/^output:.+$/.test(value)) return "entire_endpoint";
  if (/^app:[a-f0-9]{64}$/.test(value)) return "process_tree";
  const match = /^process:([1-9]\d{0,9}):([1-9]\d{0,19})$/.exec(value);
  if (!match || Number(match[1]) > 0xffffffff || BigInt(match[2]) > 0xffffffffffffffffn)
    throw fail("invalid_source");
  return "process_tree";
}

function createProtocol({ generation, scope, seconds }) {
  let state = "starting",
    lastEnd = null,
    discontinuities = 0,
    lastOnset = 0,
    lastLogOnset = 0;
  return (event) => {
    if (!event || event.v !== 2 || typeof event.type !== "string") throw fail("native_bad_version");
    if (event.type === "error") {
      if (
        !/^[a-z_]{1,64}$/.test(event.code || "") ||
        !(
          event.hresult === null ||
          (Number.isSafeInteger(event.hresult) &&
            event.hresult >= -2147483648 &&
            event.hresult <= 2147483647)
        )
      )
        throw fail("native_invalid_error");
      throw Object.assign(fail(event.code), { hresult: event.hresult });
    }
    if (event.generation !== generation) throw fail("native_stale_generation");
    if (state === "ended") throw fail("native_after_end");
    if (event.type === "hello") {
      if (state !== "starting" || event.scope !== scope || event.max_seconds !== seconds)
        throw fail("native_scope_mismatch");
      state = "activating";
      return { type: "hello", generation, scope };
    }
    if (event.type === "ready") {
      const f = event.format;
      if (
        state !== "activating" ||
        f?.encoding !== "f32le" ||
        f.sample_rate !== 48000 ||
        f.channels !== 2 ||
        f.frame_bytes !== 8 ||
        f.window_frames !== 960 ||
        event.signal !== "waiting"
      )
        throw fail("native_format_mismatch");
      state = "ready";
      return {
        type: "ready",
        generation,
        format: {
          encoding: "f32le",
          sampleRate: 48000,
          channels: 2,
          windowFrames: 960,
          analysis: spectral.format(f.analysis),
        },
        signal: "waiting",
      };
    }
    if (state !== "ready") throw fail("native_not_ready");
    if (event.type === "clock") {
      if (
        !/^[a-f0-9]{32}$/.test(event.nonce || "") ||
        !/^[0-9]{1,20}$/.test(event.qpc_100ns || "") ||
        BigInt(event.qpc_100ns) > 0xffffffffffffffffn
      )
        throw fail("native_invalid_clock");
      return { type: "clock", generation, nonce: event.nonce, qpc100ns: event.qpc_100ns };
    }
    if (event.type === "status") {
      if (
        !["waiting", "stale", "receiving"].includes(event.signal) ||
        !(event.last_sample_age_ms === null || integer(event.last_sample_age_ms, 3610000))
      )
        throw fail("native_invalid_status");
      if ((event.signal === "waiting") !== (event.last_sample_age_ms === null))
        throw fail("native_invalid_status");
      return {
        type: "status",
        generation,
        signal: event.signal,
        lastSampleAgeMs: event.last_sample_age_ms,
      };
    }
    if (event.type === "level") {
      const l = event.level;
      if (
        !l ||
        event.sample_rate !== 48000 ||
        !integer(l.first_frame) ||
        !integer(l.end_frame) ||
        l.end_frame - l.first_frame !== 960 ||
        !finite(l.rms, 0, 8) ||
        !finite(l.peak, 0, 8) ||
        !(l.dbfs === null || finite(l.dbfs, -1000, 100)) ||
        !Array.isArray(l.channel_rms) ||
        l.channel_rms.length !== 2 ||
        !l.channel_rms.every((v) => finite(v, 0, 8)) ||
        !integer(l.invalid_samples, 1920) ||
        !integer(l.clipped_samples, 1920) ||
        !["silent", "signal", "invalid"].includes(l.signal)
      )
        throw fail("native_invalid_measurement");
      if (
        (l.rms === 0) !== (l.dbfs === null) ||
        (l.signal === "silent" && (l.rms !== 0 || l.peak !== 0)) ||
        l.invalid_samples > 0 !== (l.signal === "invalid") ||
        (l.invalid_samples === 0 && (l.peak === 0) !== (l.signal === "silent")) ||
        l.rms > l.peak + 1e-8 ||
        l.channel_rms.some((v) => v > l.peak + 1e-8) ||
        Math.abs(l.rms - Math.hypot(...l.channel_rms) / Math.sqrt(2)) > 1e-8 ||
        (l.rms > 0 && Math.abs(l.dbfs - 20 * Math.log10(l.rms)) > 1e-6) ||
        l.peak >= 1 !== l.clipped_samples > 0
      )
        throw fail("native_invalid_measurement");
      if (
        !integer(event.discontinuities) ||
        event.discontinuities < discontinuities ||
        (lastEnd !== null && event.discontinuities === discontinuities && l.first_frame !== lastEnd)
      )
        throw fail("native_sample_discontinuity");
      if (!(event.qpc_end_100ns === null || /^\d{1,20}$/.test(event.qpc_end_100ns)))
        throw fail("native_invalid_timestamp");
      lastEnd = l.end_frame;
      discontinuities = event.discontinuities;
      const analysis = spectral.analysis(l.analysis, l.end_frame, lastOnset, lastLogOnset);
      if (l.invalid_samples > 0 && analysis?.valid) throw fail("native_invalid_analysis");
      if (analysis?.onset) lastOnset = analysis.onset.id;
      if (analysis?.logOnset) lastLogOnset = analysis.logOnset.id;
      return {
        type: "level",
        generation,
        firstFrame: l.first_frame,
        endFrame: l.end_frame,
        rms: l.rms,
        peak: l.peak,
        dbfs: l.dbfs,
        channelRms: [...l.channel_rms],
        signal: l.signal,
        invalidSamples: l.invalid_samples,
        clippedSamples: l.clipped_samples,
        discontinuities,
        qpcEnd100ns: event.qpc_end_100ns,
        analysis,
      };
    }
    if (event.type === "ended") {
      if (
        !["duration", "parent_stop", "source_exited"].includes(event.reason) ||
        !integer(event.packets) ||
        !integer(event.frames) ||
        !integer(event.discontinuities)
      )
        throw fail("native_invalid_end");
      state = "ended";
      return {
        type: "ended",
        generation,
        reason: event.reason,
        packets: event.packets,
        frames: event.frames,
        discontinuities: event.discontinuities,
      };
    }
    throw fail("native_unknown_event");
  };
}

function validateSource(item) {
  const scope = source(item?.id);
  if (
    typeof item.label !== "string" ||
    item.label.length > 260 ||
    /[\x00-\x1f\x7f]/.test(item.label) ||
    item.scope !== scope ||
    item.kind !== (scope === "process_tree" ? "application" : "output")
  )
    throw fail("native_invalid_source");
  return { id: item.id, label: item.label, kind: item.kind, scope };
}

module.exports = { createLines, createProtocol, source, validateSource };
