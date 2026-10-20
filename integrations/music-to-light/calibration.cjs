/** A one-time listening-level reference, never a rolling song normalizer.
 * Measure at a comfortable volume; this code cannot change any audio volume.
 * A fixed 24 dB span preserves quiet/loud structure after the capture ends.
 */
module.exports = function deriveCalibration(samples, headroomDb = 0) {
  if (!Number.isFinite(headroomDb) || headroomDb < 0 || headroomDb > 12)
    throw Object.assign(Error("invalid_music_calibration"), { code: "invalid_music_calibration" });
  const valid = samples
    .filter((n) => Number.isFinite(n) && n >= -100 && n <= 18)
    .sort((a, b) => a - b);
  if (valid.length < 200)
    throw Object.assign(Error("music_calibration_insufficient_audio"), {
      code: "music_calibration_insufficient_audio",
    });
  const high = valid[Math.floor((valid.length - 1) * 0.95)];
  if (high < -60)
    throw Object.assign(Error("music_calibration_too_quiet"), {
      code: "music_calibration_too_quiet",
    });
  // Explicit headroom reserves response for a louder phrase than the sample.
  // It shifts both ends together; the dynamic span stays fixed after sampling.
  const ceilingDb = Math.max(-60, Math.min(0, Math.round(high + headroomDb)));
  return { ceilingDb, floorDb: Math.min(-20, ceilingDb - 24) };
};
