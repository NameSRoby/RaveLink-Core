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
  const inboxRoot = path.resolve(String(options.inboxRoot || path.join(process.cwd(), "mod")));
  const packageManager = options.packageManager;
  const log = options.log || console;
  if (!packageManager?.inspectSource || !packageManager?.inspectArchive) {
    throw new Error("createModDropInbox requires a package manager");
  }
  const events = new EventEmitter();
  events.setMaxListeners(64);
  let rows = [];
  let watcher = null;
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
      resources: row.manifest ? { ...row.manifest.resources } : null,
      fingerprint: row.approval?.fingerprint || ""
    };
  }

  async function inspectEntry(entry) {
    const sourcePath = path.join(inboxRoot, entry.name);
    const kind = entry.isDirectory() ? "directory" : (entry.isFile() && path.extname(entry.name).toLowerCase() === ".zip" ? "archive" : "");
    if (!kind || entry.isSymbolicLink() || entry.name.startsWith(".")) return null;
    const result = kind === "archive"
      ? await packageManager.inspectArchive(sourcePath)
      : await packageManager.inspectSource(sourcePath);
    return {
      candidateId: candidateId(entry.name),
      sourceName: entry.name,
      sourcePath,
      kind,
      valid: result.ok === true,
      error: result.ok === true ? "" : String(result.error || "package_invalid"),
      manifest: result.ok === true ? result.manifest : null,
      approval: result.ok === true ? result.approval : null
    };
  }

  async function performScan() {
    if (stopped) return list();
    await fs.promises.mkdir(inboxRoot, { recursive: true });
    let entries = await fs.promises.readdir(inboxRoot, { withFileTypes: true });
    entries = entries.sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_INBOX_ENTRIES);
    const next = [];
    for (const entry of entries) {
      try {
        const row = await inspectEntry(entry);
        if (row) next.push(row);
      } catch (error) {
        next.push({
          candidateId: candidateId(entry.name), sourceName: entry.name, kind: "unknown",
          valid: false, error: String(error?.message || "package_inspection_failed").slice(0, 120),
          manifest: null, approval: null, sourcePath: path.join(inboxRoot, entry.name)
        });
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
    timer = setTimeout(() => { timer = null; void scan(); }, SCAN_DEBOUNCE_MS);
    timer.unref?.();
  }

  function start() {
    if (startPromise) return startPromise;
    startPromise = (async () => {
      await scan();
      if (stopped || watcher) return list();
      try {
        watcher = fs.watch(inboxRoot, { recursive: process.platform === "win32" }, scheduleScan);
        watcher.on("error", error => log.warn?.(`[MOD INBOX] watcher error: ${error?.message || error}`));
      } catch (error) {
        log.warn?.(`[MOD INBOX] watcher unavailable: ${error?.message || error}`);
      }
      return list();
    })();
    return startPromise;
  }

  function ready() { return startPromise || start(); }

  function list() {
    return { ok: true, inbox: "mod", total: rows.length, candidates: rows.map(publicRow) };
  }

  function resolve(id) {
    return rows.find(row => row.candidateId === String(id || "")) || null;
  }

  function subscribe(listener) {
    events.on("change", listener);
    return () => events.off("change", listener);
  }

  async function shutdown() {
    stopped = true;
    clearTimeout(timer);
    watcher?.close();
    watcher = null;
    events.removeAllListeners();
    await scanning.catch(() => {});
  }

  return Object.freeze({ inboxRoot, list, ready, resolve, scan, scheduleScan, start, subscribe, shutdown });
};

module.exports.candidateId = candidateId;
module.exports.MAX_INBOX_ENTRIES = MAX_INBOX_ENTRIES;
