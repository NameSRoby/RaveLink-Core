/** Deterministic spatial masks. Shape, timing and mixture remain locked; only
 * measured events/energy advance them. No oscillator invents an audio onset.
 * Raised-cosine focus profiles have smooth edges. Normalization uses the sampled
 * reactive layout so a narrow focus cannot disappear between two sparse bulbs.
 */
const clamp = (v) => Math.max(0, Math.min(1, v));
const bump = (distance, width) =>
  distance >= width ? 0 : 0.5 + 0.5 * Math.cos((Math.PI * distance) / width);
function focus(position, front, width, positions, transform = (v) => v) {
  let nearest = Infinity;
  for (const value of positions) nearest = Math.min(nearest, Math.abs(transform(value) - front));
  const distance = Math.max(0, Math.abs(transform(position) - front) - nearest);
  return bump(distance, Math.max(0.1, width));
}
function compose({ shape, position, positions, at, onsets, audioTravel, side, feel, b }) {
  let main = 1,
    depth = 0;
  if (shape === "wave") {
    depth = b.waveDepth;
    const duration = b.waveMs / feel.motion;
    // Overlaps use max, not an unbounded sum. Endpoints fade instead of vanishing
    // on the final frame; the accepted reference keeps its original renderer.
    main = 0;
    const limit = Math.max(1, Math.min(16, Math.round(b.waveVoices)));
    const voices =
      onsets.length <= limit
        ? onsets
        : limit === 1
          ? onsets.slice(-1)
          : [...onsets.slice(0, Math.ceil(limit / 2)), ...onsets.slice(-Math.floor(limit / 2))];
    for (const t of voices) {
      if (at < t || at - t >= duration) continue;
      const age = (at - t) / duration;
      const fade = 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, age / 0.1, (1 - age) / 0.15));
      main = Math.max(main, focus(position, age, b.waveWidth, positions) * fade);
    }
  } else if (shape === "bounce" || shape === "mirror") {
    depth = b.interactionDepth;
    const cycle = ((audioTravel * feel.motion) / b.bounceSeconds) % 1;
    const front = 0.5 - 0.5 * Math.cos(2 * Math.PI * cycle);
    main = focus(
      position,
      front,
      b.waveWidth,
      positions,
      shape === "mirror" ? (v) => Math.abs(v - 0.5) * 2 : undefined,
    );
  } else if (shape === "handoff") {
    depth = b.interactionDepth;
    main = focus(position, side, 1, positions);
  } else if (shape === "swell") {
    depth = b.swellDepth;
    main =
      0.5 +
      0.5 *
        Math.cos(
          2 *
            Math.PI *
            ((audioTravel * feel.motion) / b.swellTravelSeconds - position * b.swellSpan),
        );
  }
  // Mix the main bounded mask with a gentle spatial companion. A share is a
  // contribution, never a second multiplicative dimmer or an extra brightness gain.
  const accent =
    shape === "unison"
      ? 1
      : 0.5 +
        0.5 *
          Math.cos(2 * Math.PI * ((audioTravel * feel.motion) / b.bounceSeconds - position * 0.5));
  const share = b.spatialAccentShare;
  const mask = (1 - share) * main + share * accent;
  return clamp(1 - depth + depth * mask);
}
function reactivePositions(fixtures) {
  const positions = fixtures
    .filter((f) => !f.raveBehavior || f.raveBehavior === "reactive")
    .map((f) => f.position)
    .filter(Number.isFinite);
  return positions.length ? positions : [0];
}
function rememberOnset(previous, at, b, feel) {
  const duration = b.waveMs / feel.motion,
    limit = Math.max(1, Math.min(16, Math.round(b.waveVoices)));
  const next = previous.filter((t) => at - t < duration);
  next.push(at);
  // Retain older travelling fronts as well as new attacks. Repeatedly keeping
  // only the newest fronts prevents any wave reaching distant fixtures under
  // dense percussion. One voice deliberately retains single-front behavior.
  while (next.length > limit) next.splice(Math.floor(limit / 2), 1);
  return next;
}
module.exports = { compose, bump, focus, reactivePositions, rememberOnset };
