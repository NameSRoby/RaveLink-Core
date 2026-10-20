/** Persistent app identity -> fresh, bounded process-tree capture.
 * Private native image/package metadata never enters browser/feature DTOs.
 * Ancestry and OS package identity are evidence; executable names alone are not.
 * No microphone, desktop-output fallback, cross-app guessing or idle capture.
 */
const crypto = require("node:crypto"),
  path = require("node:path"),
  { EventEmitter } = require("node:events");
const { validateSource } = require("./protocol.cjs");
const fault = (code) => Object.assign(Error(code), { code });
function identity(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !["image", "package"].includes(k))
  )
    throw fault("invalid_audio_app_identity");
  if (
    typeof value.package === "string" &&
    value.package.length > 0 &&
    value.package.length <= 512 &&
    !/[\x00-\x1f]/.test(value.package)
  )
    return { package: value.package.toLowerCase() };
  if (
    typeof value.image !== "string" ||
    value.image.length > 4096 ||
    !path.win32.isAbsolute(value.image) ||
    /[\x00-\x1f]/.test(value.image)
  )
    throw fault("invalid_audio_app_identity");
  return { image: path.win32.normalize(value.image).toLowerCase() };
}
const key = (value) =>
  "app:" +
  crypto
    .createHash("sha256")
    .update(JSON.stringify(identity(value)))
    .digest("hex");
const same = (a, b) =>
  a.package
    ? !!b.package && a.package.toLowerCase() === b.package.toLowerCase()
    : !!b.image && a.image === path.win32.normalize(b.image).toLowerCase();
function nodeIdentity(n) {
  return identity(n.package ? { package: n.package } : { image: n.image });
}
function labelFor(n) {
  const name = path.win32.basename(n.image).replace(/\.exe$/i, "");
  if (n.package && /^appleinc\.applemusic_/i.test(n.package)) return "Apple Music";
  if (/^(firefox|chrome|msedge|brave|opera|vivaldi)$/i.test(name))
    return name + " (all browser audio)";
  return name;
}
function catalog(raw) {
  if (
    !raw ||
    !Array.isArray(raw.processes) ||
    raw.processes.length > 1024 ||
    !Array.isArray(raw.sources) ||
    raw.sources.length > 257
  )
    throw fault("invalid_audio_app_catalog");
  const nodes = new Map();
  for (const n of raw.processes) {
    if (
      !Number.isInteger(n.pid) ||
      n.pid < 1 ||
      n.pid > 0xffffffff ||
      !Number.isInteger(n.parent) ||
      n.parent < 0 ||
      n.parent > 0xffffffff ||
      typeof n.created !== "string" ||
      !/^\d{1,20}$/.test(n.created) ||
      BigInt(n.created) > 0xffffffffffffffffn ||
      typeof n.image !== "string"
    )
      throw fault("invalid_audio_app_catalog");
    nodeIdentity(n);
    nodes.set(n.pid, n);
  }
  const groups = new Map(),
    outputs = [];
  for (const row of raw.sources) {
    const source = validateSource(row);
    if (source.kind === "output") {
      outputs.push(source);
      continue;
    }
    const parts = /^process:(\d+):(\d+)$/.exec(source.id);
    if (!parts) throw fault("invalid_audio_app_catalog");
    let node = nodes.get(Number(parts[1]));
    if (!node || node.created !== parts[2]) continue;
    const visited = new Set();
    // Climb only the same OS package/image, or a verified parent inside the same
    // installation directory. Never promote capture to Explorer/a system broker.
    for (let depth = 0; depth < 32; depth++) {
      const parent = nodes.get(node.parent);
      if (!parent || visited.has(parent.pid) || BigInt(parent.created) > BigInt(node.created))
        break;
      visited.add(node.pid);
      const related =
        same(nodeIdentity(node), parent) ||
        (!node.package &&
          !parent.package &&
          path.win32.dirname(node.image).toLowerCase() ===
            path.win32.dirname(parent.image).toLowerCase());
      if (!related) break;
      node = parent;
    }
    const ident = nodeIdentity(node),
      id = key(ident);
    let group = groups.get(id);
    if (!group) {
      group = {
        id,
        label: labelFor(node).slice(0, 240),
        identity: ident,
        roots: new Map(),
        sources: new Set(),
      };
      groups.set(id, group);
    }
    group.sources.add(source.id);
    const captureId = `process:${node.pid}:${node.created}`;
    const previous = group.roots.get(captureId);
    group.roots.set(captureId, {
      id: captureId,
      active: previous?.active || row.active === true,
      peak: Math.max(previous?.peak || 0, Number.isFinite(row.peak) ? row.peak : 0),
      producer: source.label,
    });
  }
  return { groups, outputs, processes: [...nodes.values()] };
}
module.exports = function createApplicationSources({ native, known = [] } = {}) {
  const remembered = new Map();
  let resolution = { state: "unresolved" };
  let priorities = [],
    current = null;
  function remember(input) {
    if (!input || input.version !== 1) throw fault("invalid_audio_app_binding");
    const source = validateSource(input.source);
    if (source.kind === "output" || source.id === "fullscreen-app") {
      remembered.set(source.id, { version: 1, source });
      return source;
    }
    const ident = identity(input.identity);
    if (key(ident) !== source.id) throw fault("invalid_audio_app_binding");
    remembered.set(source.id, { version: 1, source, identity: ident });
    return source;
  }
  known.forEach(remember);
  async function enumerate(options = {}) {
    const data = catalog(await native.applicationCatalog(options));
    for (const g of data.groups.values())
      remember({
        version: 1,
        source: { id: g.id, label: g.label, kind: "application", scope: "process_tree" },
        identity: g.identity,
      });
    for (const s of data.outputs) remember({ version: 1, source: s });
    return data;
  }
  function resolveFrom(id, data) {
    const binding = remembered.get(id);
    if (!binding) throw fault("music_source_selection_required");
    if (binding.source.kind === "output") {
      if (!data.outputs.some((source) => source.id === id))
        throw fault("music_selected_app_not_running");
      resolution = { state: "ready", label: binding.source.label };
      return id;
    }
    if (id === "fullscreen-app") return id;
    let group = data.groups.get(id);
    if (!group) {
      // Windows may remove an idle application's audio session. Its verified
      // process can still be captured now, including audio children born later.
      // Match the saved private identity, never a display name or another app.
      const sources = data.processes
        .filter((node) => same(binding.identity, node))
        .map((node) => ({
          id: `process:${node.pid}:${node.created}`,
          label: labelFor(node),
          kind: "application",
          scope: "process_tree",
        }));
      if (sources.length) group = catalog({ processes: data.processes, sources }).groups.get(id);
    }
    if (!group) {
      resolution = { state: "not_running", label: binding.source.label };
      throw fault("music_selected_app_not_running");
    }
    let roots = [...group.roots.values()];
    // Inactive historical sessions must not masquerade as a second current audio
    // producer. Multiple independent audible roots remain explicit ambiguity;
    // choosing the loudest would silently omit selected browser audio.
    const audible = roots.filter((r) => r.active || r.peak > 0);
    if (audible.length) roots = audible;
    if (roots.length !== 1) {
      resolution = { state: "ambiguous", label: binding.source.label };
      throw fault("music_selected_app_multiple_roots");
    }
    resolution = {
      state: "ready",
      label: binding.source.label,
      producer: roots[0].producer,
      association: binding.identity.package ? "windows_package" : "process_ancestry",
    };
    return roots[0].id;
  }
  async function resolve(id, options = {}) {
    if (!remembered.has(id)) throw fault("music_source_selection_required");
    const data = await enumerate(options);
    const slots = priorities.find(Boolean) === id ? priorities : [id];
    for (const [priority, selected] of slots.entries()) {
      if (!selected) continue;
      try {
        const root = resolveFrom(selected, data);
        resolution = { ...resolution, priority };
        return { root, label: remembered.get(selected).source.label, priority };
      } catch (error) {
        // Only verified absence permits fallback. Ambiguity or failed catalog
        // verification must never silently broaden or change audio capture.
        if (error.code !== "music_selected_app_not_running") throw error;
      }
    }
    throw fault("music_selected_app_not_running");
  }
  function capture(id, options) {
    if (!remembered.has(id)) throw fault("music_source_selection_required");
    const generation = crypto.randomBytes(16).toString("hex"),
      events = new EventEmitter(),
      abort = new AbortController();
    let child,
      canceled = false,
      closed = false;
    const done = (async () => {
      try {
        const selected = await resolve(id, { signal: abort.signal });
        if (canceled) return { reason: "parent_stop" };
        child = native.capture(selected.root, options);
        current = { generation, label: selected.label, priority: selected.priority };
        child.events.on("update", (e) => {
          if (!canceled) events.emit("update", { ...e, generation });
        });
        return await child.done;
      } finally {
        closed = true;
        if (current?.generation === generation) current = null;
        events.removeAllListeners();
      }
    })();
    return {
      events,
      done,
      stop() {
        canceled = true;
        abort.abort();
        child?.stop();
      },
      snapshot() {
        return child
          ? { ...child.snapshot(), generation }
          : { state: closed ? "stopped" : "resolving", generation, signal: "waiting" };
      },
    };
  }
  return {
    available: native.available,
    identify: native.identify,
    listSources: async (options) => {
      const data = await enumerate(options);
      return [
        ...(native.supportsFullscreen
          ? [
              remember({
                version: 1,
                source: {
                  id: "fullscreen-app",
                  label: "Active fullscreen / borderless app",
                  kind: "application",
                  scope: "process_tree",
                },
              }),
            ]
          : []),
        ...data.outputs,
        ...[...data.groups.values()].map((g) => remembered.get(g.id).source),
      ];
    },
    capture,
    // One-time local upgrade bridge: accept only an exact still-live legacy
    // PID+creation selection. This is never a basename-based migration.
    adoptExact: async (id) => {
      const data = await enumerate();
      const output = data.outputs.find((s) => s.id === id);
      if (output) return structuredClone(remembered.get(output.id));
      const group = [...data.groups.values()].find((g) => g.sources.has(id));
      if (!group) throw fault("music_selected_app_not_running");
      return structuredClone(remembered.get(group.id));
    },
    ensureAvailable: async (id, options) => (await resolve(id, options)).root,
    current: () => (current ? { label: current.label, priority: current.priority } : null),
    setPriorities(ids) {
      if (
        !Array.isArray(ids) ||
        ids.length !== 3 ||
        ids.some((id) => id !== null && !remembered.has(id)) ||
        new Set(ids.filter(Boolean)).size !== ids.filter(Boolean).length
      )
        throw fault("invalid_music_source_priorities");
      priorities = [...ids];
    },
    remember,
    describe: (id) => structuredClone(remembered.get(id) || null),
    resolution: () => ({ ...resolution }),
  };
};
module.exports.identity = identity;
module.exports.key = key;
module.exports.catalog = catalog;
