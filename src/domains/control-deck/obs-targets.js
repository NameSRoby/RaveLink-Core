const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const fault = (code) => Object.assign(Error(code), { code });
const kinds = [
  "scene",
  "preview",
  "source-toggle",
  "source-show",
  "source-hide",
  "mute-toggle",
  "mute",
  "unmute",
  "volume",
  "filter-toggle",
  "filter-enable",
  "filter-disable",
  "studio-toggle",
  "transition",
  "transition-choice",
  "record-toggle",
  "stream-toggle",
  "virtualcam-toggle",
  "replay-save",
];
const text = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 256 &&
  !/[\x00-\x1f]/.test(value);
function normalize(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Object.keys(input).some(
      (k) =>
        ![
          "kind",
          "sceneName",
          "sourceName",
          "filterName",
          "sceneItemId",
          "group",
          "transitionName",
          "duration",
          "collectionName",
          "scope",
        ].includes(k),
    ) ||
    !kinds.includes(input.kind)
  )
    throw fault("obs_target_invalid");
  const out = { kind: input.kind };
  if (input.collectionName !== undefined) {
    if (!text(input.collectionName)) throw fault("obs_target_invalid");
    out.collectionName = input.collectionName;
  }
  if (
    input.scope !== undefined &&
    (!input.kind.startsWith("source-") || !["all", "scene"].includes(input.scope))
  )
    throw fault("obs_target_invalid");
  if (input.scope === "all") out.scope = "all";
  const required = input.kind.startsWith("source-")
    ? input.scope === "all"
      ? ["sourceName"]
      : ["sceneName", "sourceName"]
    : input.kind.startsWith("filter-")
      ? ["sourceName", "filterName"]
      : ["mute-toggle", "mute", "unmute", "volume"].includes(input.kind)
        ? ["sourceName"]
        : ["scene", "preview"].includes(input.kind)
          ? ["sceneName"]
          : input.kind === "transition-choice"
            ? ["transitionName"]
            : [];
  for (const key of required) {
    if (!text(input[key])) throw fault("obs_target_invalid");
    out[key] = input[key];
  }
  if (input.kind.startsWith("source-") && input.scope !== "all") {
    if (
      !Number.isSafeInteger(input.sceneItemId) ||
      input.sceneItemId < 0 ||
      typeof input.group !== "boolean"
    )
      throw fault("obs_target_invalid");
    out.sceneItemId = input.sceneItemId;
    out.group = input.group;
  }
  if (input.kind === "transition-choice") {
    if (!Number.isInteger(input.duration) || input.duration < 50 || input.duration > 20000)
      throw fault("obs_target_invalid");
    out.duration = input.duration;
  }
  return out;
}
const title = (t) =>
  (({
    scene: "Scene: ",
    preview: "Preview scene: ",
    "source-toggle": "Show / hide: ",
    "source-show": "Show: ",
    "source-hide": "Hide: ",
    "mute-toggle": "Mute / unmute: ",
    mute: "Mute: ",
    unmute: "Unmute: ",
    volume: "Volume: ",
    "filter-toggle": "Toggle filter: ",
    "filter-enable": "Enable filter: ",
    "filter-disable": "Disable filter: ",
    "studio-toggle": "Studio Mode",
    transition: "Transition to program",
    "transition-choice": "Transition: ",
    "record-toggle": "Recording",
    "stream-toggle": "Streaming",
    "virtualcam-toggle": "Virtual camera",
    "replay-save": "Save replay",
  })[t.kind] || "OBS") +
  (t.filterName
    ? t.sourceName + " / " + t.filterName
    : t.sceneName || t.sourceName || t.transitionName || "");
module.exports = function obsTargets(runtimeDir) {
  const file = path.join(runtimeDir, "system", "obs-buttons.json"),
    rows = new Map();
  const id = (t) =>
    "obs:" + crypto.createHash("sha256").update(JSON.stringify(t)).digest("hex").slice(0, 32);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 262144) throw Error();
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(saved) || saved.length > 192) throw Error();
    for (const row of saved) {
      const t = normalize(row);
      rows.set(id(t), t);
    }
  } catch {
    rows.clear();
  }
  return {
    rows,
    add(input) {
      const target = normalize(input),
        key = id(target);
      if (!rows.has(key)) {
        if (rows.size >= 192) throw fault("obs_button_limit");
        const next = new Map(rows);
        next.set(key, target);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file + ".tmp", JSON.stringify([...next.values()]) + "\n", { mode: 0o600 });
        fs.renameSync(file + ".tmp", file);
        rows.set(key, target);
      }
      return { id: key, target, label: title(target) };
    },
  };
};
module.exports.normalize = normalize;
module.exports.title = title;
