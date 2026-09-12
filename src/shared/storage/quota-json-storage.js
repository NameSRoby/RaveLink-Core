// [TITLE] Module: capabilities/mod-platform/host/mod-storage-service.js
// [TITLE] Purpose: provide isolated quota-bound JSON state without filesystem access
// [TITLE] Functionality Index:
// [TITLE] - map normalized keys only inside one workload-owned directory
// [TITLE] - reject links and enforce exact serialized-byte quotas
// [TITLE] - serialize atomic mutations and return bounded status metadata

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const DEFAULT_IDENTITY_RE = /^[a-z0-9][a-z0-9.-]{1,63}$/;
const MAX_KEYS = 250;

async function exists(target) {
  try { return await fs.promises.lstat(target); } catch { return null; }
}

module.exports = function createQuotaJsonStorage(options = {}) {
  const dataRoot = path.resolve(String(options.dataRoot || path.join(process.cwd(), "runtime", "mods", "data")));
  const identityPattern = options.identityPattern instanceof RegExp ? options.identityPattern : DEFAULT_IDENTITY_RE;
  const invalidIdentityError = String(options.invalidIdentityError || "invalid_workload_id");
  const operations = new Map();

  function serialize(workloadId, task) {
    const previous = operations.get(workloadId) || Promise.resolve();
    const next = previous.then(task, task);
    const tracked = next.catch(() => {});
    operations.set(workloadId, tracked);
    return next.finally(() => { if (operations.get(workloadId) === tracked) operations.delete(workloadId); });
  }

  function context(manifest) {
    const workloadId = String(manifest?.id || "");
    if (!identityPattern.test(workloadId)) return { ok: false, error: invalidIdentityError };
    if (manifest?.permissions?.storage !== true) return { ok: false, error: "storage_permission_denied" };
    const quotaBytes = Math.min(8 * 1024 * 1024, Math.max(0, Number(manifest?.resources?.storageBytes) || 0));
    if (!quotaBytes) return { ok: false, error: "storage_quota_disabled" };
    return { ok: true, workloadId, root: path.join(dataRoot, workloadId), quotaBytes };
  }

  async function inventory(root) {
    const rootStat = await exists(root);
    if (!rootStat) return { ok: true, files: [], usedBytes: 0 };
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return { ok: false, error: "storage_root_invalid" };
    const files = [];
    let usedBytes = 0;
    for (const entry of await fs.promises.readdir(root, { withFileTypes: true })) {
      if (entry.isFile() && /^\.[a-z0-9._-]+-\d+-[a-f0-9]+\.tmp$/.test(entry.name)) {
        await fs.promises.rm(path.join(root, entry.name), { force: true });
        continue;
      }
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) return { ok: false, error: "storage_entry_invalid" };
      const stat = await fs.promises.lstat(path.join(root, entry.name));
      if (!stat.isFile() || stat.isSymbolicLink()) return { ok: false, error: "storage_entry_invalid" };
      usedBytes += stat.size;
      files.push({ key: entry.name.slice(0, -5), bytes: stat.size });
      if (files.length > MAX_KEYS) return { ok: false, error: "storage_key_limit" };
    }
    files.sort((a, b) => a.key.localeCompare(b.key));
    return { ok: true, files, usedBytes };
  }

  async function get(manifest, key) {
    const ctx = context(manifest);
    if (!ctx.ok) return ctx;
    if (!KEY_RE.test(String(key || ""))) return { ok: false, error: "invalid_storage_key" };
    const target = path.join(ctx.root, `${key}.json`);
    const stat = await exists(target);
    if (!stat) return { ok: true, found: false, value: null };
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > ctx.quotaBytes) return { ok: false, error: "storage_entry_invalid" };
    try { return { ok: true, found: true, value: JSON.parse(await fs.promises.readFile(target, "utf8")) }; }
    catch { return { ok: false, error: "storage_value_invalid" }; }
  }

  function set(manifest, key, value) {
    const ctx = context(manifest);
    if (!ctx.ok) return Promise.resolve(ctx);
    if (!KEY_RE.test(String(key || ""))) return Promise.resolve({ ok: false, error: "invalid_storage_key" });
    let bytes;
    try { bytes = Buffer.from(JSON.stringify(value), "utf8"); } catch { return Promise.resolve({ ok: false, error: "storage_value_invalid" }); }
    if (!bytes.length || bytes.length > ctx.quotaBytes) return Promise.resolve({ ok: false, error: "storage_quota_exceeded" });
    return serialize(ctx.workloadId, async () => {
      const current = await inventory(ctx.root);
      if (!current.ok) return current;
      const prior = current.files.find(row => row.key === key)?.bytes || 0;
      if (current.usedBytes - prior + bytes.length > ctx.quotaBytes) return { ok: false, error: "storage_quota_exceeded" };
      if (!prior && current.files.length >= MAX_KEYS) return { ok: false, error: "storage_key_limit" };
      await fs.promises.mkdir(ctx.root, { recursive: true });
      const temp = path.join(ctx.root, `.${key}-${process.pid}-${crypto.randomBytes(5).toString("hex")}.tmp`);
      try {
        await fs.promises.writeFile(temp, bytes, { flag: "wx", mode: 0o600 });
        await fs.promises.rename(temp, path.join(ctx.root, `${key}.json`));
      } finally {
        await fs.promises.rm(temp, { force: true }).catch(() => {});
      }
      return { ok: true, key, bytes: bytes.length, usedBytes: current.usedBytes - prior + bytes.length, quotaBytes: ctx.quotaBytes };
    });
  }

  function remove(manifest, key) {
    const ctx = context(manifest);
    if (!ctx.ok) return Promise.resolve(ctx);
    if (!KEY_RE.test(String(key || ""))) return Promise.resolve({ ok: false, error: "invalid_storage_key" });
    return serialize(ctx.workloadId, async () => {
      const target = path.join(ctx.root, `${key}.json`);
      const stat = await exists(target);
      if (stat && (!stat.isFile() || stat.isSymbolicLink())) return { ok: false, error: "storage_entry_invalid" };
      if (stat) await fs.promises.rm(target, { force: true });
      return { ok: true, removed: Boolean(stat) };
    });
  }

  async function status(manifest) {
    const ctx = context(manifest);
    if (!ctx.ok) return ctx;
    const current = await inventory(ctx.root);
    return current.ok ? { ok: true, keys: current.files.map(row => row.key), usedBytes: current.usedBytes, quotaBytes: ctx.quotaBytes } : current;
  }

  return Object.freeze({ get, remove, set, status });
};
