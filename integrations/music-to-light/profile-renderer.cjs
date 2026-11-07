/** Choreography consumes validated audio once. Rendering is read-only: preview
 * cannot advance a gesture, redraw colors or change the physical output clock.
 */
const clamp = (v) => Math.max(0, Math.min(1, v));
module.exports = function profileRenderer(inner, fixtures) {
  let config = inner.settings();
  if (!config.behaviors.profileMotion) return inner;
  const active = fixtures
    .filter((f) => !f.raveBehavior || f.raveBehavior === "reactive")
    .sort((a, b) => a.position - b.position);
  const slots = new Map(active.map((f, i) => [f.id, i]));
  let hits = 0,
    lastHit = null,
    sampledAt = null;
  let weights = active.map(() => 1);
  function focus(index, count, step, mode) {
    if (count < 2 || mode < 2) return 1;
    if (mode === 2) return index === step % count ? 1 : 0;
    if (mode === 3) {
      const phase = step % (2 * (count - 1));
      return index === (phase < count ? phase : 2 * (count - 1) - phase) ? 1 : 0;
    }
    if (mode === 4) return Number(index < Math.ceil(count / 2) === (step % 2 === 0));
    if (mode === 7) {
      const pair = Math.min(index, count - 1 - index),
        pairs = Math.ceil(count / 2);
      const phase = step % Math.max(1, 2 * (pairs - 1));
      return Number(pair === (phase < pairs ? phase : 2 * (pairs - 1) - phase));
    }
    if (mode === 9) return Number(index % 2 === step % 2);
    return 1;
  }
  return Object.freeze({
    ...inner,
    update(event, at) {
      inner.update(event, at);
      const inspection = inner.inspect(at),
        b = inspection.effective.behaviors;
      config = inspection.effective;
      if (
        inspection.metrics?.colorChangeAt !== null &&
        inspection.metrics?.colorChangeAt !== undefined &&
        inspection.metrics.colorChangeAt !== lastHit
      ) {
        lastHit = inspection.metrics.colorChangeAt;
        hits++;
      }
      const step = Math.floor(Math.max(0, hits - 1) / b.profileBeats);
      const bands = event.analysis?.bandRms;
      const validBands = Array.isArray(bands) && bands.length === 3 && bands.some((v) => v > 0);
      const peak = validBands ? Math.max(...bands) : 1;
      const delta = sampledAt === null ? 1000 : Math.max(0, at - sampledAt);
      const mix = 1 - Math.exp(-delta / b.profileBlendMs);
      weights = active.map((f, i) => {
        let target = focus(i, active.length, step, b.profileMotion);
        if (active.length > 1 && [5, 6].includes(b.profileMotion) && validBands) {
          const band = b.profileMotion === 5 ? (i % 2 === 0 ? 0 : 2) : i % 3;
          target = Math.sqrt(clamp(bands[band] / peak));
        }
        if (active.length > 1 && b.profileMotion === 8) {
          const level = inspection.metrics?.level ?? 0;
          target = clamp(level * active.length - i);
        }
        return weights[i] + (target - weights[i]) * mix;
      });
      sampledAt = at;
    },
    render(at, fixture = {}) {
      const index = slots.get(fixture.id),
        b = config.behaviors;
      if (!b.profileMotion || index === undefined) return inner.render(at, fixture);
      const count = active.length;
      const spread = b.profileSpread * ((fixture.assignedPalette || config.palette).length - 1);
      const slot =
        b.profileMotion === 1 || b.profileMotion === 9
          ? index % 2
          : b.profileMotion === 7
            ? Math.min(index, count - 1 - index) / Math.max(1, Math.ceil(count / 2) - 1)
            : index / Math.max(1, count - 1);
      const frame = inner.render(at, { ...fixture, profileColorOffset: slot * spread });
      if (!frame || frame.sceneNative) return frame;
      const gain = 1 - b.profileDepth * (1 - weights[index]);
      return {
        ...frame,
        brightness: config.minimumBrightness + (frame.brightness - config.minimumBrightness) * gain,
      };
    },
    configure(input) {
      const result = inner.configure(input);
      config = inner.settings();
      return result;
    },
  });
};
