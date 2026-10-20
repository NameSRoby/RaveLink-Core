/** Schema projection for real spectral measurements. No guessed beat/tempo is
 * accepted. Onsets have unique IDs and detection times, never a held boolean.
 */
const fail = () =>
  Object.assign(new Error("native_invalid_analysis"), { code: "native_invalid_analysis" });
const finite = (n, max) => Number.isFinite(n) && n >= 0 && n <= max;
const integer = (n) => Number.isSafeInteger(n) && n >= 0;

function format(value) {
  if (
    value?.fft_size !== 2048 ||
    value.hop_frames !== 960 ||
    value.window !== "hann" ||
    value.flux !== "positive_magnitude_difference" ||
    value.onset_refractory_frames !== 5760 ||
    JSON.stringify(value.band_edges_hz) !== "[20,250,4000,20000]"
  )
    throw fail();
  return {
    fftSize: 2048,
    hopFrames: 960,
    window: "hann",
    bandEdgesHz: [20, 250, 4000, 20000],
    flux: "positive_magnitude_difference",
    onsetRefractoryFrames: 5760,
  };
}
function analysis(value, endFrame, lastOnset, lastLogOnset = 0) {
  if (value === null) return null;
  if (
    !value ||
    !integer(value.first_frame) ||
    value.end_frame !== endFrame ||
    endFrame - value.first_frame !== 2048 ||
    typeof value.valid !== "boolean" ||
    !Array.isArray(value.band_rms) ||
    value.band_rms.length !== 3 ||
    !value.band_rms.every((v) => finite(v, 16)) ||
    !finite(value.spectral_flux, 1024) ||
    !finite(value.onset_threshold, 4096)
  )
    throw fail();
  let onset = null;
  if (value.onset !== null) {
    const o = value.onset;
    if (
      !o ||
      !integer(o.id) ||
      o.id <= lastOnset ||
      o.detected_at_frame !== endFrame ||
      !finite(o.strength, 1024) ||
      o.strength !== value.spectral_flux ||
      o.strength <= value.onset_threshold ||
      !value.valid
    )
      throw fail();
    onset = { id: o.id, detectedAtFrame: o.detected_at_frame, strength: o.strength };
  }
  if (!value.valid && (value.spectral_flux !== 0 || onset)) throw fail();
  const result = {
    firstFrame: value.first_frame,
    endFrame,
    bandRms: [...value.band_rms],
    spectralFlux: value.spectral_flux,
    onsetThreshold: value.onset_threshold,
    onset,
    valid: value.valid,
  };
  if (
    Object.hasOwn(value, "log_spectral_flux") ||
    Object.hasOwn(value, "log_onset_threshold") ||
    Object.hasOwn(value, "log_onset")
  ) {
    // Reuse the same bounds/replay checks independently for the second detector.
    // Old helpers remain decodable; enhanced sessions can report their fallback.
    const logged = analysis(
      {
        first_frame: value.first_frame,
        end_frame: value.end_frame,
        band_rms: value.band_rms,
        valid: value.valid,
        spectral_flux: value.log_spectral_flux,
        onset_threshold: value.log_onset_threshold,
        onset: value.log_onset,
      },
      endFrame,
      lastLogOnset,
    );
    result.logSpectralFlux = logged.spectralFlux;
    result.logOnsetThreshold = logged.onsetThreshold;
    result.logOnset = logged.onset;
  }
  return result;
}
module.exports = { format, analysis };
