// [TITLE] Module: capabilities/mod-platform/packages/mod-drop-inbox.js
// [TITLE] Purpose: detect untrusted drop-in packages without executing them

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const EventEmitter = require("node:events");

const MAX_INBOX_ENTRIES = 128;
const SCAN_DEBOUNCE_MS = 300;

function candidateId(name) {
  return crypto.createHash("sha256").update(String(name)).digest("hex").slice(0, 24);
}

module.exports = function createModDropInbox(options = {}) {
  const inboxRoot = path.resolve(String(options.inboxRoot || path.join(process.cwd(), "mods")));
  const roots = [
    ...new Set(
      [inboxRoot, options.legacyInboxRoot && path.resolve(options.legacyInboxRoot)].filter(Boolean),
    ),
  ];
  const packageManager = options.packageManager;
  const log = options.log || console;
  if (!packageManager?.inspectSource || !packageManager?.inspectArchive) {
    throw new Error("createModDropInbox requires a package manager");
  }
  const events = new EventEmitter();
  events.setMaxListeners(64);
  let rows = [];
  const watchers = [];
  let timer = null;
  let scanning = Promise.resolve();
  let startPromise = null;
  let stopped = false;

  function publicRow(row) {
    return {
      candidateId: row.candidateId,
      sourceName: row.sourceName,
      kind: row.kind,
      valid: row.valid,
      error: row.error,
      id: row.manifest?.id || "",
      name: row.manifest?.name || row.sourceName,
      version: row.manifest?.version || "",
      publisher: row.manifest?.publisher || "",
      license: row.manifest?.license || "",
      permissions: row.manifest ? { ...row.manifest.permissions } : null,
      consumes: row.manifest ? [...row.manifest.consumes] : [],
      resources: row.manifest ? { ...row.manifest.resources } : null,
      fingerprint: row.approval?.fingerprint || "",
      packageFingerprint: row.manifest ? require("./mod-content-fingerprint")(row.manifest) : "",
    };
  }

  async function inspectEntry(entry, root) {
    const sourcePath = path.join(root, entry.name);
    const sourceName = root === inboxRoot ? entry.name : "mod/" + entry.name;
    const kind = entry.isDirectory()
      ? "directory"
      : entry.isFile() && path.extname(entry.name).toLowerCase() === ".zip"
        ? "archive"
        : "";
    if (!kind || entry.isSymbolicLink() || entry.name.startsWith(".")) return null;
    const result =
      kind === "archive"
        ? await packageManager.inspectArchive(sourcePath)
        : await packageManager.inspectSource(sourcePath);
    return {
      candidateId: candidateId(sourceName),
      sourceName,
      sourcePath,
      kind,
      valid: result.ok === true,
      error: result.ok === true ? "" : String(result.error || "package_invalid"),
      manifest: result.ok === true ? result.manifest : null,
      approval: result.ok === true ? result.approval : null,
    };
  }

  async function performScan() {
    if (stopped) return list();
    await fs.promises.mkdir(inboxRoot, { recursive: true });
    const next = [];
    for (const root of roots) {
      if (!fs.existsSync(root)) continue;
      const stat = await fs.promises.lstat(root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      let entries = await fs.promises.readdir(root, { withFileTypes: true });
      entries = entries
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, MAX_INBOX_ENTRIES - next.length);
      for (const entry of entries) {
        try {
          const row = await inspectEntry(entry, root);
          if (row) next.push(row);
        } catch (error) {
          next.push({
            candidateId: candidateId(root === inboxRoot ? entry.name : "mod/" + entry.name),
            sourceName: root === inboxRoot ? entry.name : "mod/" + entry.name,
            kind: "unknown",
            valid: false,
            error: String(error?.message || "package_inspection_failed").slice(0, 120),
            manifest: null,
            approval: null,
            sourcePath: path.join(root, entry.name),
          });
        }
      }
    }
    rows = next;
    events.emit("change", list());
    return list();
  }

  function scan() {
    scanning = scanning.then(performScan, performScan);
    return scanning;
  }

  function scheduleScan() {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      scan().catch((error) =>
        log.warn?.(`[MOD INBOX] scan unavailable: ${error?.message || error}`),
      );
    }, SCAN_DEBOUNCE_MS);
    timer.unref?.();
  }

  function start() {
    if (startPromise) return startPromise;
    startPromise = (async () => {
      await scan();
      if (stopped || watchers.length) return list();
      for (const root of roots) {
        if (!fs.existsSync(root) || fs.lstatSync(root).isSymbolicLink()) continue;
        try {
          const watcher = fs.watch(root, { recursive: process.platform === "win32" }, scheduleScan);
          watchers.push(watcher);
          watcher.on("error", (error) =>
            log.warn?.(`[MOD INBOX] watcher error: ${error?.message || error}`),
          );
        } catch (error) {
          log.warn?.(`[MOD INBOX] watcher unavailable: ${error?.message || error}`);
        }
      }
      return list();
    })();
    return startPromise;
  }

  function ready() {
    return startPromise || start();
  }

  function list() {
    return {
      ok: true,
      inbox: "mods",
      total: rows.length,
      candidates: rows.map(publicRow),
    };
  }

  function resolve(id) {
    return rows.find((row) => row.candidateId === String(id || "")) || null;
  }

  function subscribe(listener) {
    events.on("change", listener);
    return () => events.off("change", listener);
  }

  async function shutdown() {
    stopped = true;
    clearTimeout(timer);
    for (const watcher of watchers.splice(0)) watcher.close();
    events.removeAllListeners();
    await scanning.catch(() => {});
  }

  return Object.freeze({
    inboxRoot,
    list,
    ready,
    resolve,
    scan,
    scheduleScan,
    start,
    subscribe,
    shutdown,
  });
};

module.exports.candidateId = candidateId;
module.exports.MAX_INBOX_ENTRIES = MAX_INBOX_ENTRIES;
