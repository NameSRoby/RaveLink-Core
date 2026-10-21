/** Activation-only weighted choice. Audio never influences the draw or redraws
 * a running recipe. Weights express operator preference. A zero weight is a
 * hard exclusion, including fallback. Only a new activation consumes randomness.
 */
const definitions = Object.freeze(
  [
    {
      id: "wash",
      label: "Swell wash",
      help: "A sustained glow following loudness and rises.",
      preset: "ambient",
    },
    {
      id: "pulse",
      label: "Attack pulse",
      help: "Measured attacks over a low sustained bed.",
      preset: "pulse",
    },
    {
      id: "bands",
      label: "Band conversation",
      help: "Independent low, mid and high frequency roles.",
      preset: "bands",
    },
    {
      id: "wave",
      label: "Attack wave",
      help: "Measured attacks travel across fixture positions.",
      preset: "pulse",
    },
    {
      id: "bounce",
      label: "Room bounce",
      preset: "pulse",
      help: "An attack-lit focus travels between room ends and returns, driven by measured energy.",
    },
    {
      id: "handoff",
      label: "Call & response",
      preset: "pulse",
      help: "Measured attacks hand the leading role between opposite sides of the room.",
    },
  ].map(Object.freeze),
);
function weights(input = {}) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((k) => !definitions.some((d) => d.id === k))
  )
    throw Error("invalid_music_scenarios");
  const value = Object.fromEntries(
    definitions.map((d) => [
      d.id,
      Object.hasOwn(input, d.id)
        ? input[d.id]
        : Object.keys(input).length && ["bounce", "handoff"].includes(d.id)
          ? 0
          : 1,
    ]),
  );
  if (Object.values(value).some((v) => !Number.isFinite(v) || v < 0 || v > 10))
    throw Error("invalid_music_scenarios");
  return value;
}
function chances(config) {
  const values = definitions.map((d) => ({
    ...d,
    weight: config[d.id],
    score: config[d.id],
  }));
  const total = values.reduce((n, r) => n + r.score, 0);
  return values.map((d) => ({ ...d, chance: total ? d.score / total : 0 }));
}
function choose(config, random = Math.random, history = null) {
  const rows = chances(config);
  const allowed = rows.filter((r) => r.score > 0);
  if (!allowed.length) return null;
  if (history) {
    const draw = history.draw(
      "scenario",
      allowed.map((r) => ({ id: r.id, weight: r.score })),
      random,
    );
    const selected = allowed.find((r) => r.id === draw.id);
    return {
      id: selected.id,
      preset: selected.preset,
      roll: draw.roll,
      candidates: rows.map((r) => ({
        ...r,
        score: draw.probabilities[r.id] ? r.weight : 0,
        chance: draw.probabilities[r.id] || 0,
      })),
    };
  }
  const roll = random();
  if (!Number.isFinite(roll) || roll < 0 || roll >= 1) throw Error("invalid_music_random");
  let cursor = roll;
  for (const row of allowed) {
    cursor -= row.chance;
    if (cursor < 0) return { id: row.id, preset: row.preset, roll, candidates: rows };
  }
  const last = allowed.at(-1);
  return { id: last.id, preset: last.preset, roll, candidates: rows };
}
function chooseLayers(config, scenario, random = Math.random) {
  const probabilities = {
    attacksEnabled: 0.85,
    swellsEnabled: 0.7,
    balanceEnabled: 0.75,
    colorEnabled: 0.8,
    spatialEnabled: 0.65,
  };
  const selected = {};
  for (const [id, chance] of Object.entries(probabilities)) {
    const roll = random();
    if (!Number.isFinite(roll) || roll < 0 || roll >= 1) throw Error("invalid_music_random");
    selected[id] = config[id] && roll < chance;
  }
  // Keep the defining mechanism of a shape when it is allowed. A pulse without
  // attacks or a wave without spatial response is an unhelpful random result.
  if (
    ["pulse", "wave", "bounce", "handoff"].includes(scenario) ||
    (config.loudnessBrightness && !config.steadyBrightness)
  )
    selected.attacksEnabled = config.attacksEnabled;
  if (["wave", "wash", "bounce", "handoff"].includes(scenario))
    selected.spatialEnabled = config.spatialEnabled;
  if (scenario === "bands") selected.balanceEnabled = config.balanceEnabled;
  if (["wash", "bands"].includes(scenario)) selected.swellsEnabled = config.swellsEnabled;
  return selected;
}
module.exports = { definitions, weights, chances, choose, chooseLayers };
