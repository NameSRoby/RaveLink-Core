/** Palette scope is independent of task/effect selection. Bound distinct color
 * channels to eight; larger rooms reuse them rather than create idle renderers.
 */
const generate = require("./random-palette.cjs");
const { family } = require("./temperature-colors.cjs");
const { rgb } = require("./palette-math.cjs");
const signature = (colors) => [...colors].sort().join(",");
function manualPalette(config, used, roll, history) {
  const prior = history?.recent?.("manual-palette-subsets") || [];
  const mixed =
    config.warmCoolColors && new Set(config.palette.map((c) => family(rgb(c)))).size > 1;
  let winner,
    best = -Infinity;
  for (let i = 0; i < 16; i++) {
    const count =
      config.palette.length <= 2
        ? 2
        : 2 +
          ((Math.floor(roll() * (config.palette.length - 1)) + i) % (config.palette.length - 1));
    const offset = (Math.floor(roll() * config.palette.length) + i) % config.palette.length;
    const colors = Array.from(
      { length: count },
      (_, at) => config.palette[(offset + at) % config.palette.length],
    );
    const key = signature(colors);
    let score = used.some((p) => signature(p) === key) ? -10 : 0;
    if (mixed && new Set(colors.map((c) => family(rgb(c)))).size < 2) score -= 30;
    for (let at = 0; at < prior.length; at++)
      if (prior[at] === key) score -= (at + 1) / prior.length;
    if (score > best) {
      winner = colors;
      best = score;
    }
  }
  history?.remember?.("manual-palette-subsets", signature(winner));
  return winner;
}
module.exports = function palettes(rows, config, random, history, selectedPalette) {
  const option = config.recipeOptions.paletteScope;
  const roll = () => {
    const n = random();
    if (!Number.isFinite(n) || n < 0 || n >= 1) throw Error("invalid_music_random");
    return n;
  };
  const scope =
    !option || option.mode === "configured"
      ? "shared"
      : option.mode === "fixed"
        ? option.value
        : option.allowed[Math.floor(roll() * option.allowed.length)];
  if (scope === "shared") return rows;
  const groups = new Map(),
    colors = [];
  const generated =
    selectedPalette !== undefined
      ? selectedPalette === "generated"
      : config.recipeOptions.palette?.mode !== "configured" &&
        config.recipeOptions.palette?.value === "generated" &&
        config.recipeOptions.palette.allowed.length === 1;
  for (const f of rows) {
    if (f.raveBehavior !== "reactive" || f.assignedPalette) continue;
    const key =
      scope === "effects" ? f.assignedEffect || "shared" : f.id || "preview:" + f.position;
    if (!groups.has(key)) {
      const index = groups.size % 8;
      if (!colors[index]) {
        if (generated)
          colors[index] = index === 0 ? [...config.palette] : generate(random, history);
        else colors[index] = manualPalette(config, colors.filter(Boolean), roll, history);
      }
      groups.set(key, colors[index]);
    }
    f.assignedPalette = [...groups.get(key)];
  }
  return rows;
};
