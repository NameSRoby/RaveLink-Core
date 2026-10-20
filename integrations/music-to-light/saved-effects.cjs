/** Local saved artistic combinations. Profiles never grant sources, fixtures or
 * brightness/calibration/transport permissions. Policy is drawn only at Start.
 */
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { settings } = require("./mapping-settings.cjs");
const fault = (code) => Object.assign(Error(code), { code });
const artisticKeys = [
  "preset",
  "interpretation",
  "arrangement",
  "feel",
  "palette",
  "colorMode",
  "colorSeconds",
  "behaviors",
  "recipeOptions",
  "parameterRanges",
  "scenarioMode",
  "layerMode",
];
const pickArt = (design) =>
  Object.fromEntries(artisticKeys.map((k) => [k, structuredClone(design[k])]));
function freezeCurrent(pipeline, transition = {}) {
  if (!pipeline?.effective || !pipeline.recipe) throw fault("music_effect_not_running");
  const config = settings(pipeline.effective);
  config.preset = pipeline.preset;
  config.scenarioMode = "manual";
  config.layerMode = "fixed";
  config.parameterRanges = {};
  config.recipeOptions = {
    shape: { mode: "fixed", value: pipeline.recipe.shape, allowed: [pipeline.recipe.shape] },
  };
  config.colorMode = pipeline.recipe.color;
  config.feel = pipeline.recipe.feel;
  for (const phase of ["opening", "ending"])
    if (Number.isInteger(transition[phase + "Style"]))
      config.behaviors[phase + "Style"] = transition[phase + "Style"];
  return pickArt(settings(config));
}
module.exports = function createSavedEffects({ storePath, random = Math.random } = {}) {
  let state = { version: 1, policy: { mode: "full-random", ids: [] }, profiles: [] },
    recovered = false,
    lastId = null;
  const checkId = (id) => typeof id === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(id);
  function validate(value) {
    if (
      !value ||
      value.version !== 1 ||
      !Array.isArray(value.profiles) ||
      value.profiles.length > 32
    )
      throw fault("invalid_music_effect_library");
    const ids = new Set();
    for (const p of value.profiles) {
      if (
        !checkId(p.id) ||
        ids.has(p.id) ||
        typeof p.name !== "string" ||
        !p.name.trim() ||
        p.name.length > 80 ||
        !p.artistic ||
        Object.keys(p.artistic).some((k) => !artisticKeys.includes(k))
      )
        throw fault("invalid_music_effect_profile");
      p.assignments?.forEach((a) => require("./fixture-behavior.cjs").validate(a));
      ids.add(p.id);
      settings(p.artistic);
      if (
        p.artistic.scenarioMode !== "manual" ||
        p.artistic.layerMode !== "fixed" ||
        Object.keys(p.artistic.parameterRanges || {}).length ||
        Object.values(p.artistic.recipeOptions || {}).some((o) => o.mode === "random")
      )
        throw fault("invalid_music_effect_profile");
      if (
        !Array.isArray(p.assignments) ||
        p.assignments.length > 64 ||
        p.assignments.some(
          (a) =>
            !/^[a-zA-Z0-9._-]{1,64}$/.test(a.id) ||
            !["all", "low", "mid", "high"].includes(a.role) ||
            !["reactive", "dim", "steady", "off"].includes(a.raveBehavior),
        )
      )
        throw fault("invalid_music_effect_profile");
    }
    const p = value.policy;
    if (
      !p ||
      Object.keys(p).some((k) => !["mode", "ids"].includes(k)) ||
      !["full-random", "single", "saved-random"].includes(p.mode) ||
      !Array.isArray(p.ids) ||
      new Set(p.ids).size !== p.ids.length ||
      p.ids.some((id) => !ids.has(id)) ||
      (p.mode === "single" && p.ids.length !== 1) ||
      (p.mode === "saved-random" && !p.ids.length)
    )
      throw fault("invalid_music_effect_policy");
    return structuredClone(value);
  }
  if (storePath && fs.existsSync(storePath))
    try {
      const stat = fs.lstatSync(storePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 524288) throw Error();
      state = validate(JSON.parse(fs.readFileSync(storePath, "utf8")));
    } catch {
      recovered = true;
    }
  function commit(next) {
    next = validate(next);
    if (Buffer.byteLength(JSON.stringify(next), "utf8") > 524288)
      throw fault("music_effect_library_full");
    if (storePath) {
      try {
        fs.mkdirSync(path.dirname(storePath), { recursive: true });
        fs.writeFileSync(storePath + ".tmp", JSON.stringify(next) + "\n", { mode: 0o600 });
        fs.renameSync(storePath + ".tmp", storePath);
      } catch {
        throw fault("music_effect_save_failed");
      }
    }
    state = next;
    recovered = false;
    return snapshot();
  }
  function snapshot() {
    return { ...structuredClone(state), recovered };
  }
  function save({ name }, pipeline, transition) {
    if (typeof name !== "string" || !name.trim() || name.length > 80)
      throw fault("invalid_music_effect_name");
    const profile = {
      id: crypto.randomBytes(8).toString("hex"),
      name: name.trim(),
      artistic: freezeCurrent(pipeline, transition),
      assignments: (pipeline.assignments || [])
        .filter((a) => typeof a.id === "string")
        .map(
          ({ id, role, raveBehavior = "reactive", sceneBrightness, sceneFadeMs, colorSlot }) => ({
            id,
            role,
            raveBehavior,
            ...(sceneBrightness === undefined ? {} : { sceneBrightness }),
            ...(sceneFadeMs === undefined ? {} : { sceneFadeMs }),
            ...(colorSlot === undefined ? {} : { colorSlot }),
          }),
        ),
    };
    const next = structuredClone(state);
    next.profiles.push(profile);
    commit(next);
    return profile;
  }
  return {
    snapshot,
    save,
    restricted: () => state.policy.mode !== "full-random",
    policy(value) {
      return commit({ ...state, policy: value });
    },
    remove(id) {
      if (!state.profiles.some((p) => p.id === id)) throw fault("music_effect_not_found");
      if (state.policy.ids.includes(id) && state.policy.mode !== "full-random")
        throw fault("music_effect_profile_in_use");
      return commit({
        ...state,
        profiles: state.profiles.filter((p) => p.id !== id),
        policy: { ...state.policy, ids: state.policy.ids.filter((p) => p !== id) },
      });
    },
    choose(base, fixtures) {
      if (recovered) throw fault("music_effect_library_unavailable");
      if (state.policy.mode === "full-random") return { design: base, fixtures, profile: null };
      const allowed = state.profiles.filter((p) => state.policy.ids.includes(p.id));
      if (!allowed.length) throw fault("music_no_saved_effects");
      const pool = allowed.length > 1 ? allowed.filter((p) => p.id !== lastId) : allowed;
      const roll = random();
      if (!Number.isFinite(roll) || roll < 0 || roll >= 1) throw fault("invalid_music_random");
      const chosen = pool[Math.floor(roll * pool.length)];
      lastId = chosen.id;
      const design = settings({ ...base, ...chosen.artistic });
      const selected = fixtures?.map((f) => {
        const a = chosen.assignments.find((a) => a.id === f.id);
        return a ? { ...f, ...a } : f;
      });
      return { design, fixtures: selected, profile: { id: chosen.id, name: chosen.name } };
    },
  };
};
module.exports.freezeCurrent = freezeCurrent;

module.exports.retain = (base, profile) => settings({ ...base, ...pickArt(profile) });
