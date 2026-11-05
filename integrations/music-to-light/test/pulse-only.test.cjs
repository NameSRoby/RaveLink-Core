const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { settings } = require("../mapping-settings.cjs");
const legacy = require("../legacy-response.cjs");
const recipe = require("../recipe.cjs");
const scenarios = require("../scenarios.cjs");
const looks = require("../looks.cjs");
const planner = require("../fixture-planner.cjs");
const mapper = require("../mapper.cjs");
const library = require("../saved-effects.cjs");

test("only Pulse responses and compatible spatial variants are offered", () => {
  assert.equal(settings().preset, "pulse");
  assert.deepEqual(
    scenarios.definitions.map((s) => s.id),
    ["pulse", "wave", "bounce", "handoff"],
  );
  assert.deepEqual(
    recipe.axes.find((a) => a.id === "effect").choices,
    Object.keys(planner.EFFECTS),
  );
  for (const look of looks) assert.equal(settings(look.design).preset, "pulse");
  for (const row of Object.values(planner.EFFECTS)) assert.equal(row.preset, "pulse");
  for (const id of legacy.retiredBehaviors)
    assert.ok(!require("../behavior-settings.cjs").catalog.some((f) => f.id === id));
});

test("retired settings migrate without changing calibration, limits, palettes or movement", () => {
  for (const preset of ["ambient", "bands"]) {
    const design = settings({
      preset,
      raveScenario: preset === "ambient" ? "wash" : "bands",
      floorDb: -48,
      ceilingDb: -22,
      maximumBrightness: 42,
      palette: ["#123456", "#fedcba"],
      arrangement: "roles",
      behaviors: { ambientContrast: 2, bandSensitivity: 3, smoothing: 0.5 },
      scenarioWeights: { wash: 0, bands: 3, pulse: 0, wave: 0 },
      recipeOptions: {
        effect: { mode: "random", value: "wash", allowed: ["wash", "bands", "pulse", "wave"] },
        palette: { mode: "fixed", value: "prism-bands", allowed: ["prism-bands"] },
        shape: { mode: "fixed", value: "mirror", allowed: ["mirror"] },
      },
      parameterRanges: {
        ambientContrast: { min: 1, max: 2 },
        pulseDecayMs: { min: 250, max: 500 },
      },
    });
    assert.equal(design.preset, "pulse");
    assert.equal(design.raveScenario, "pulse");
    assert.equal(design.arrangement, "roles");
    assert.equal(design.floorDb, -48);
    assert.equal(design.ceilingDb, -22);
    assert.equal(design.maximumBrightness, 42);
    assert.deepEqual(design.palette, ["#123456", "#fedcba"]);
    assert.equal(design.behaviors.smoothing, 0.5);
    for (const id of legacy.retiredBehaviors) assert.ok(!Object.hasOwn(design.behaviors, id));
    assert.deepEqual(design.scenarioWeights, { pulse: 3, wave: 0, bounce: 0, handoff: 0 });
    assert.deepEqual(design.recipeOptions.effect.allowed, ["pulse", "wave"]);
    assert.equal(design.recipeOptions.palette.value, "prism-pulse");
    assert.equal(design.recipeOptions.shape.value, "mirror");
    assert.deepEqual(design.parameterRanges, { pulseDecayMs: { min: 250, max: 500 } });
    assert.equal(mapper(design).preset(), "pulse");
    assert.deepEqual(settings(design), design, "canonical settings survive a second load");
  }
});

test("legacy saved effects retain fixture colors and jobs when restored as Pulse", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-pulse-migration-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storePath = path.join(root, "effects.json");
  const lib = library({ storePath });
  const saved = lib.save(
    { name: "Existing favourite" },
    {
      ...mapper({ preset: "pulse" }).inspect(0),
      assignments: [
        {
          id: "a",
          role: "low",
          raveBehavior: "reactive",
          assignedEffect: "pulse",
          assignedPalette: ["#123456", "#fedcba"],
        },
        { id: "b", role: "all", raveBehavior: "dim", sceneBrightness: 7 },
      ],
    },
  );
  lib.policy({ mode: "single", ids: [saved.id] });
  const old = JSON.parse(fs.readFileSync(storePath, "utf8"));
  old.profiles[0].artistic.preset = "bands";
  old.profiles[0].artistic.behaviors.bandsBed = 0.8;
  old.profiles[0].assignments[0].assignedEffect = "bands";
  fs.writeFileSync(storePath, JSON.stringify(old));
  const restored = library({ storePath });
  assert.equal(restored.snapshot().recovered, false);
  const replay = restored.choose(settings({ maximumBrightness: 42 }), [
    { id: "a", role: "all", position: 0 },
    { id: "b", role: "all", position: 1 },
  ]);
  assert.equal(replay.design.preset, "pulse");
  assert.equal(replay.design.maximumBrightness, 42);
  assert.equal(replay.fixtures[0].assignedEffect, "pulse");
  assert.deepEqual(replay.fixtures[0].assignedPalette, ["#123456", "#fedcba"]);
  assert.equal(replay.fixtures[0].role, "low");
  assert.equal(replay.fixtures[1].raveBehavior, "dim");
  assert.equal(replay.fixtures[1].sceneBrightness, 7);
  assert.ok(!Object.hasOwn(replay.design.behaviors, "bandsBed"));
});
