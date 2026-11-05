/** Offline production-path audit. Synthetic features plus optional private
 * analyzed windows; never opens capture, acquires lights or sends network I/O.
 */
const fs = require("node:fs");
const path = require("node:path");
const { simulate } = require("../integrations/music-to-light/simulation.cjs");
const createMapper = require("../integrations/music-to-light/mapper.cjs");
const compatibility = require("../integrations/music-to-light/recipe-compatibility.cjs");
const looks = require("../integrations/music-to-light/looks.cjs");
const history = require("../integrations/music-to-light/recipe-history.cjs")();
const root = path.resolve(__dirname, "..");
const rng = (seed) => () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
const count = Number(process.argv.find((v) => v.startsWith("--cases="))?.split("=")[1] || 2400);
if (!Number.isInteger(count) || count < 1 || count > 100000)
  throw Error("invalid_simulation_case_count");
const signals = ["percussion", "dense", "sustained", "bass", "treble", "quiet", "silence"];
function synthetic(kind) {
  return Array.from({ length: 400 }, (_, i) => {
    const hit = i % (kind === "dense" ? 8 : 25) === 0;
    const rms =
      kind === "silence" || i >= 300
        ? 0
        : kind === "quiet"
          ? 0.002
          : kind === "sustained"
            ? 0.045
            : (hit ? 0.09 : 0.025) * (0.8 + 0.2 * Math.cos(i / 30));
    return {
      endFrame: (i + 1) * 960,
      discontinuities: 0,
      rms,
      signal: rms ? "signal" : "silent",
      invalidSamples: 0,
      analysis: {
        valid: true,
        bandRms: [
          rms * (kind === "treble" ? 0.02 : 0.8),
          rms * 0.45,
          rms * (kind === "bass" ? 0 : 0.3),
        ],
        onset:
          hit && !["quiet", "silence", "sustained"].includes(kind) && rms
            ? { id: i + 1, detectedAtFrame: (i + 1) * 960 }
            : null,
      },
    };
  });
}
const windows = signals.map((kind) => ({ kind, features: synthetic(kind) }));
const privateFeatures = path.join(
  root,
  "runtime/simulations/tidal-do-it-do-it-features-private.json",
);
if (fs.existsSync(privateFeatures)) {
  const values = JSON.parse(fs.readFileSync(privateFeatures, "utf8")).features;
  for (let offset = 0; offset + 400 <= values.length; offset += 2400) {
    const features = values.slice(offset, offset + 400).map((item, i) => {
      const event = item.event || item,
        endFrame = (i + 1) * 960;
      const analysis = event.analysis ? { ...event.analysis } : undefined;
      for (const key of ["onset", "logOnset"])
        if (analysis?.[key])
          analysis[key] = { ...analysis[key], id: i + 1, detectedAtFrame: endFrame };
      return {
        endFrame,
        discontinuities: 0,
        rms: event.rms,
        signal: event.rms ? "signal" : "silent",
        invalidSamples: 0,
        analysis,
      };
    });
    windows.push({ kind: "analyzed-window-" + windows.length, features });
  }
}
const option = (allowed) => ({ mode: "random", value: allowed[0], allowed });
const baseline = looks.find((l) => l.id === "rave-mix").design;
const rows = [],
  samples = [],
  failures = [];
let frames = 0,
  commands = 0,
  tupleRejected = 0,
  rawTuples = 0;
for (const rule of Object.values(compatibility.combinations))
  for (const color of ["fixed", "onsets", "travel", "roles", "energy"])
    for (const feel of ["slow", "normal", "fast", "aggressive"]) {
      rawTuples++;
      if (!rule.colors.includes(color) || !rule.feels.includes(feel)) tupleRejected++;
    }
for (let seed = 1; seed <= count; seed++) {
  const random = rng(seed * 1009),
    n = [1, 2, 3, 6, 12, 64][(seed - 1) % 6];
  const brand = ["wiz", "hue", "govee"][Math.floor((seed - 1) / 6) % 3];
  const fixtures = Array.from({ length: n }, (_, i) => ({
    id: "f" + i,
    brand,
    entertainmentActive: brand === "hue" && Math.floor((seed - 1) / 18) % 2 === 0,
    role: "all",
    raveBehavior: "reactive",
    position: n > 1 ? i / (n - 1) : 0,
  }));
  const grouped = Math.floor((seed - 1) / 6) % 2 === 0;
  const design = {
    ...baseline,
    intensity: 0.8,
    minimumBrightness: 10,
    maximumBrightness: 70,
    outputHz: [2, 4, 8, 16][Math.floor((seed - 1) / 18) % 4],
    scenarioMode: "manual",
    layerMode: "fixed",
    recipeOptions: {
      ...baseline.recipeOptions,
      palette: { mode: "fixed", value: "generated", allowed: ["generated"] },
      ...(grouped
        ? {
            effect: option(["pulse", "wave", "bounce", "handoff"]),
            role: option(["all", "low", "mid", "high"]),
          }
        : {}),
    },
    behaviors: { ...baseline.behaviors, openingStyle: 0, endingStyle: 0 },
  };
  if (grouped) design.recipeOptions.feel = { mode: "fixed", value: "normal", allowed: ["normal"] };
  const input = windows[(seed - 1) % windows.length];
  try {
    const instance = createMapper(design, { fixtures, random: rng(seed * 1009) });
    const selected = instance.inspect(0);
    const legal = compatibility.candidates(
      require("../integrations/music-to-light/mapping-settings.cjs").settings(design),
      "unison",
      fixtures,
    );
    if (
      !legal.some(
        (r) =>
          r.shape === selected.recipe.shape &&
          r.color === selected.recipe.color &&
          r.feel === selected.recipe.feel,
      )
    )
      throw Error("illegal_composition");
    const result = simulate({ features: input.features, fixtures, design, random, history });
    frames += result.length;
    let invalid = 0,
      jumps = 0,
      floor = 0,
      peak = 0,
      minimum = 100,
      ceiling = 0,
      spread = 0;
    for (let i = 0; i < result.length; i++) {
      const frame = result[i],
        brightness = frame.lights.map((f) => f.brightness);
      spread += Math.max(...brightness) - Math.min(...brightness);
      for (let j = 0; j < frame.lights.length; j++) {
        const light = frame.lights[j];
        commands++;
        if (
          !Number.isFinite(light.brightness) ||
          light.brightness < 10 - 1e-6 ||
          light.brightness > 70 + 1e-6 ||
          Object.values(light.rgb).some((v) => !Number.isInteger(v) || v < 0 || v > 255)
        )
          invalid++;
        peak = Math.max(peak, light.brightness);
        minimum = Math.min(minimum, light.brightness);
        if (light.brightness <= 11) floor++;
        if (light.brightness >= 69) ceiling++;
        if (i) jumps += Math.abs(light.brightness - result[i - 1].lights[j].brightness);
      }
    }
    if (invalid) failures.push({ seed, reason: "invalid_output", invalid });
    if (["quiet", "silence"].includes(input.kind) && peak > 10.4)
      failures.push({ seed, reason: "invented_quiet_energy", peak });
    if (signals.includes(input.kind) && result.at(-1)?.lights.some((f) => f.brightness > 10.4))
      failures.push({ seed, reason: "silence_did_not_settle" });
    const row = {
      seed,
      fixtures: n,
      brand,
      grouped,
      signal: input.kind,
      recipe: result[0]?.recipe,
      frames: result.length,
      range: peak - minimum,
      meanStep: jumps / Math.max(1, result.length * n),
      meanSpread: spread / Math.max(1, result.length),
      floorFraction: floor / Math.max(1, result.length * n),
      ceilingFraction: ceiling / Math.max(1, result.length * n),
    };
    rows.push(row);
    if (samples.length < 24 && n <= 6 && !["quiet", "silence"].includes(input.kind))
      samples.push({ ...row, frames: result.filter((_, i) => i % 2 === 0) });
  } catch (error) {
    failures.push({ seed, reason: error.message });
  }
  if (seed % 200 === 0)
    process.stdout.write(JSON.stringify({ cases: seed, frames, failures: failures.length }) + "\n");
}
const report = {
  cases: count,
  completed: rows.length,
  frames,
  fixtureSamples: commands,
  filteredCartesianPairs: tupleRejected,
  originalCartesianPairs: rawTuples,
  analyzedWindows: windows.length - signals.length,
  failures,
  rows,
};
const directory = path.join(root, "runtime/simulations");
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(directory, "coherent-recipes.json"), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(directory, "coherent-recipes-gallery.json"), JSON.stringify(samples));
console.log(
  JSON.stringify({
    ...report,
    rows: undefined,
    failures: failures.slice(0, 12),
    failureCount: failures.length,
  }),
);
if (failures.length) process.exitCode = 1;
