/** Reference-relative compensation only. Never learns from song loudness. */
const valid = (v) =>
  v &&
  typeof v.key === "string" &&
  v.key.length <= 2048 &&
  Number.isFinite(v.systemPercent) &&
  v.systemPercent >= 0 &&
  v.systemPercent <= 100 &&
  Number.isFinite(v.systemDb) &&
  v.systemDb >= -200 &&
  v.systemDb <= 30 &&
  (v.appGain === null || (Number.isFinite(v.appGain) && v.appGain >= 0 && v.appGain <= 1)) &&
  typeof v.muted === "boolean";
function validate(v) {
  if (!valid(v))
    throw Object.assign(Error("invalid_music_volume"), { code: "invalid_music_volume" });
  return {
    key: v.key,
    systemPercent: v.systemPercent,
    systemDb: v.systemDb,
    appGain: v.appGain,
    muted: v.muted,
  };
}
function correction(reference, current) {
  if (!reference || !current || reference.key !== current.key)
    return { db: 0, state: "unavailable" };
  if (reference.muted) return { db: 0, state: "unavailable" };
  if (current.muted || current.appGain === 0) return { db: 0, state: "muted" };
  // Process loopback precedes endpoint attenuation: system volume is recorded
  // for context, never applied a second time. Mixed endpoint capture has no
  // single app gain and cannot safely compensate individual applications.
  if (!(reference.appGain > 0) || !(current.appGain > 0)) return { db: 0, state: "unavailable" };
  const db = 20 * Math.log10(current.appGain / reference.appGain);
  if (Math.abs(db) > 36) return { db: 0, state: "out_of_range" };
  return { db, state: "following" };
}
module.exports = { validate, correction };
