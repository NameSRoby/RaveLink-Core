/** Joint activation-time assignment. Only supplied routes may receive jobs.
 * Candidate plans are bounded; safety/coverage precede novelty scoring.
 */
const { fault } = require("./mapping-settings.cjs");
const EFFECTS = Object.freeze({
  pulse: { preset: "pulse", shape: "unison", minimum: 1 },
  wave: { preset: "pulse", shape: "wave", minimum: 2 },
  bounce: { preset: "pulse", shape: "bounce", minimum: 2 },
  handoff: { preset: "pulse", shape: "handoff", minimum: 2 },
});
const minimum = (id, config) => (config.interpretation === "literal" ? 1 : EFFECTS[id].minimum);
function compatible(id, count, config, fixtures) {
  const b = config.behaviors;
  if (!EFFECTS[id] || count < minimum(id, config)) return false;
  if (config.interpretation === "literal") return true;
  if (id === "pulse") return true;
  if (config.interpretation !== "musical" || b.steadyBrightness) return false;
  if (["pulse", "wave", "handoff"].includes(id) && !b.attacksEnabled) return false;
  const rules = require("./recipe-compatibility.cjs");
  return (
    b.spatialEnabled &&
    rules.spatial(EFFECTS[id].shape, config, fixtures) &&
    rules.timingValid(EFFECTS[id].shape, config, fixtures)
  );
}
function plan(rows, config, rave, random = Math.random, history = null) {
  const draw = () => {
    const n = random();
    if (!Number.isFinite(n) || n < 0 || n >= 1) throw fault("invalid_music_random");
    return n;
  };
  const shuffle = (values) => {
    const result = [...values];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(draw() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  };
  const option = (axis) => config.recipeOptions[axis] || { mode: "configured" };
  const task = option("task"),
    role = option("role"),
    effect = option("effect");
  for (const axis of [task, role, effect])
    if (axis.mode !== "configured" && !axis.allowed.length) throw fault("music_no_recipe_choices");
  const original = rows.map((f) => ({
    ...f,
    raveBehavior: f.raveBehavior || "reactive",
    ...(f.assignedEffect
      ? { assignedEffect: require("./legacy-response.cjs").effect(f.assignedEffect) }
      : {}),
  }));
  const eligible = original
    .map((f, i) => (f.raveBehavior === "reactive" ? i : -1))
    .filter((i) => i >= 0);
  const randomized =
    [role, effect].some((v) => v.mode === "random") || (rave && task.mode === "random");
  const previous = history?.recent?.("fixture-plans") || [];
  const key = (f) => f.id || "preview:" + f.position;
  const identity = (f) =>
    [f.raveBehavior, f.role, f.assignedEffect || "configured", f.colorSlot ?? 0].join(":");
  let winner = original,
    best = -Infinity;
  for (let attempt = 0; attempt < (randomized ? 32 : 1); attempt++) {
    const selected = original.map((f) => ({ ...f }));
    const order = randomized ? shuffle(eligible) : eligible;
    if (randomized && order.length) order.push(...order.splice(0, attempt % order.length));
    if (rave && task.mode !== "configured") {
      const allowed = task.mode === "fixed" ? [task.value] : task.allowed;
      // A random pool that permits audio must retain an audible foreground.
      const foreground =
        task.mode === "random" && allowed.includes("reactive")
          ? Math.min(
              order.length,
              Math.max(Math.ceil(order.length / 2), effect.mode !== "configured" ? 2 : 1),
            )
          : 0;
      order.forEach((index, i) => {
        selected[index].raveBehavior =
          i < foreground
            ? "reactive"
            : allowed[(Math.floor(draw() * allowed.length) + attempt + i) % allowed.length];
        if (selected[index].raveBehavior === "steady")
          selected[index].colorSlot = i % config.palette.length;
      });
    }
    const active = order.filter((i) => selected[i].raveBehavior === "reactive");
    if (effect.mode !== "configured" && active.length) {
      const allowed = (effect.mode === "fixed" ? [effect.value] : effect.allowed).filter((id) =>
        compatible(
          id,
          active.length,
          config,
          active.map((i) => selected[i]),
        ),
      );
      if (!allowed.length) throw fault("music_no_fixture_effects");
      const groups = new Map();
      let remaining = [...active];
      while (remaining.length) {
        const choices = allowed.filter(
          (id) =>
            groups.has(id) ||
            (minimum(id, config) <= remaining.length &&
              (minimum(id, config) === 1 ||
                new Set(remaining.map((i) => selected[i].position)).size >= 2)),
        );
        if (!choices.length) throw fault("music_no_fixture_effects");
        const unused = choices.filter((id) => !groups.has(id));
        const pool = unused.length ? unused : choices;
        const id = pool[(Math.floor(draw() * pool.length) + attempt) % pool.length];
        const count = groups.has(id) ? 1 : minimum(id, config);
        const group = groups.get(id) || [];
        const first = remaining.shift();
        group.push(first);
        if (count === 2) {
          const farthest = remaining.reduce(
            (best, index) =>
              Math.abs(selected[index].position - selected[first].position) >
              Math.abs(selected[best].position - selected[first].position)
                ? index
                : best,
            remaining[0],
          );
          group.push(farthest);
          remaining.splice(remaining.indexOf(farthest), 1);
        }
        groups.set(id, group);
      }
      for (const [id, indices] of groups)
        for (const index of indices) selected[index].assignedEffect = id;
    }
    const pools = new Map();
    for (const index of active) {
      const f = selected[index];
      if (role.mode === "fixed") f.role = role.value;
      else if (role.mode === "random") {
        const id = f.assignedEffect || "coordinated";
        if (
          config.interpretation !== "literal" &&
          f.assignedEffect &&
          f.assignedEffect !== "pulse"
        ) {
          // A travelling group follows one shared audio envelope. Independent
          // bass/treble draws within it can extinguish half of a moving front.
          if (!pools.has(id))
            pools.set(id, [
              role.allowed.includes("all")
                ? "all"
                : role.allowed[Math.floor(draw() * role.allowed.length)],
            ]);
          f.role = pools.get(id)[0];
          continue;
        }
        if (!pools.get(id)?.length) {
          const values = shuffle(role.allowed);
          values.push(...values.splice(0, attempt % values.length));
          pools.set(id, values);
        }
        f.role = pools.get(id).pop();
      }
    }
    if (
      role.mode === "random" &&
      role.allowed.includes("all") &&
      active.length &&
      !active.some((i) => selected[i].role === "all")
    )
      selected[active[0]].role = "all";
    let score = new Set(active.map((i) => selected[i].assignedEffect || "configured")).size * 3;
    for (const [index, old] of previous.entries()) {
      let matches = 0,
        compared = 0;
      for (const f of selected)
        if (Object.hasOwn(old, key(f))) {
          compared++;
          if (old[key(f)] === identity(f)) matches++;
        }
      if (compared) score -= ((index + 1) / previous.length) * (matches / compared) * 4;
      if (compared && matches === compared) score -= index === previous.length - 1 ? 20 : 4;
    }
    // Role bags balance each effect group. Whole-plan comparison rotates jobs
    // across fixtures without making fixture enumeration order a visual pattern.
    if (score > best) {
      best = score;
      winner = selected;
    }
    if (!randomized) break;
  }
  if (randomized)
    history?.remember?.(
      "fixture-plans",
      Object.fromEntries(winner.map((f) => [key(f), identity(f)])),
    );
  return winner;
}
module.exports = plan;
module.exports.EFFECTS = EFFECTS;
module.exports.compatible = compatible;
