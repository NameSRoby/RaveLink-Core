/** Map measured RMS power between fixed calibration endpoints. Linear dB steps
 * compress the difference between a restrained buildup and a loud impact.
 * Fixed endpoints preserve that contrast without learning gain from the song.
 */
module.exports = function calibratedEnergy(rms, floorDb, ceilingDb) {
  if (!(rms > 0)) return 0;
  const floor = 10 ** (floorDb / 10);
  const ceiling = 10 ** (ceilingDb / 10);
  return Math.max(0, Math.min(1, (rms * rms - floor) / (ceiling - floor)));
};
