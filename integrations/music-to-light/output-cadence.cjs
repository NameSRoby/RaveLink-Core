/** Active Entertainment fixtures use the requested render cadence (up to 50 Hz).
 * REST fixtures share eight writes/second. WiZ keeps its experimental 16 Hz limit.
 * Transport readiness is server supplied after preheat, never an artistic setting.
 */
module.exports = function createCadence(fixtures = []) {
  const hueCount = () => fixtures.filter((f) => f.brand === "hue" && !f.entertainmentActive).length;
  let lastActive = -Infinity,
    heldRate = 2;
  return {
    rate(config, inspection, at) {
      if (config.outputRateMode === "fixed") return config.outputHz;
      const b = config.behaviors,
        m = inspection?.metrics;
      // Missing/stale analysis must never retain an earlier fast passage. Energy
      // is calibrated by the mapper, so the pacing baseline follows the same
      // quiet/loud reference as brightness, independently of recipe selection.
      if (!inspection?.fresh || !Number.isFinite(m?.level) || !Number.isFinite(m?.rise)) {
        heldRate = 2;
        lastActive = -Infinity;
        return 2;
      }
      const level = Math.max(0, Math.min(1, m.level)),
        rise = Math.max(0, m.rise),
        energyRate = level >= 0.8 ? 8 : level >= 0.5 ? 6 : level >= 0.2 ? 4 : 2,
        riseRate = rise >= b.rateRiseThreshold * 2 ? 16 : rise >= b.rateRiseThreshold ? 12 : 2,
        requested = Math.min(config.outputHz, m.attack ? 16 : Math.max(energyRate, riseRate));
      // Rise immediately; hold the most demanding rate through short gaps.
      // Sustained lower demand replaces it only after the operator's hold time.
      // There is no song classification, tempo guess or artistic redraw here.
      if (requested >= heldRate || at - lastActive >= b.rateHoldMs) {
        heldRate = requested;
        lastActive = at;
      }
      return Math.min(config.outputHz, heldRate);
    },
    retentionMs(fixture, rate) {
      return Math.min(500, 1000 / this.fixtureRate(fixture, rate) + 1000 / rate + 25);
    },
    fixtureRate(fixture, rate) {
      if (fixture.brand === "hue" && fixture.entertainmentActive) return Math.min(rate, 50);
      return fixture.brand === "hue"
        ? Math.min(rate, 8 / Math.max(1, hueCount()))
        : Math.min(rate, 16);
    },
  };
};
