/** Music preview and every physical fixture are capped at twelve updates per second.
 * REST fixtures share eight writes/second; Entertainment uses the requested ceiling.
 * Transport readiness is server supplied after preheat, never an artistic setting.
 */
module.exports = function createCadence(fixtures = []) {
  const hueCount = () => fixtures.filter((f) => f.brand === "hue" && !f.entertainmentActive).length;
  let lastActive = -Infinity,
    heldRate = 2;
  return {
    rate(config, inspection, at) {
      const limit = Math.min(12, config.outputHz);
      if (config.outputRateMode === "fixed") return limit;
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
        // Artistic riseGain must not turn a small measured change into
        // permission for maximum transport speed.
        rise = Math.max(0, Number.isFinite(m.energyRise) ? m.energyRise : m.rise),
        energyRate = level >= 0.8 ? 8 : level >= 0.5 ? 6 : level >= 0.2 ? 4 : 2,
        riseRate = rise >= b.rateRiseThreshold ? 12 : 2,
        attackRate = Number.isFinite(m.attackStrength)
          ? m.attackStrength >= 0.5 && level >= 0.3
            ? 12
            : 2
          : m.attack
            ? 12
            : 2,
        // Rendering frequency is interpolation quality, not effect intensity.
        // Color movement must not become a staircase between loud attacks.
        motionRate = m.colorMotion || m.brightnessMotion || m.spatialMotion ? config.outputHz : 2,
        requested = Math.min(limit, Math.max(motionRate, attackRate, energyRate, riseRate));
      // Rise immediately; hold the most demanding rate through short gaps.
      // Sustained lower demand replaces it only after the operator's hold time.
      // There is no song classification, tempo guess or artistic redraw here.
      if (requested >= heldRate || at - lastActive >= b.rateHoldMs) {
        heldRate = requested;
        lastActive = at;
      }
      return Math.min(limit, heldRate);
    },
    retentionMs(fixture, rate) {
      return Math.min(500, 1000 / this.fixtureRate(fixture, rate) + 1000 / rate + 25);
    },
    fixtureRate(fixture, rate) {
      rate = Math.min(12, rate);
      if (fixture.brand === "hue" && fixture.entertainmentActive) return rate;
      // Govee uses three separate whole-device UDP commands per frame, rather
      // than an Entertainment stream. Keep a conservative eight-frame budget.
      if (fixture.brand === "govee") return Math.min(rate, 8);
      return fixture.brand === "hue" ? Math.min(rate, 8 / Math.max(1, hueCount())) : rate;
    },
  };
};
