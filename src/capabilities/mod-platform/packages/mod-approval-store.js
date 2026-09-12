// [TITLE] Module: capabilities/mod-platform/packages/mod-approval-store.js
// [TITLE] Purpose: persist exact user approval for mod permissions and resource budgets
// [TITLE] Functionality Index:
// [TITLE] - canonicalize permission/resource declarations and calculate fingerprints
// [TITLE] - report additions, removals, increases, and decreases on update
// [TITLE] - atomically approve or revoke a mod without storing credentials

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function canonicalGrant(manifest) {
  const permissions = manifest?.permissions || {};
  const resources = manifest?.resources || {};
  return {
    permissions: {
      network: [...(permissions.network || [])].sort(),
      storage: permissions.storage === true,
      secrets: [...(permissions.secrets || [])].sort(),
      ui: permissions.ui === true,
      process: permissions.process === true,
      hardware: [...(permissions.hardware || [])].sort()
    },
    resources: Object.fromEntries(Object.keys(resources).sort().map(key => [key, resources[key]]))
  };
}

function grantFingerprint(grant) {
  return crypto.createHash("sha256").update(JSON.stringify(grant)).digest("hex");
}

function diffGrants(previous = null, next) {
  const before = previous || { permissions: {}, resources: {} };
  const added = [];
  const removed = [];
  for (const key of ["network", "secrets", "hardware"]) {
    const oldSet = new Set(before.permissions?.[key] || []);
    const newSet = new Set(next.permissions?.[key] || []);
    for (const value of newSet) if (!oldSet.has(value)) added.push(`permissions.${key}:${value}`);
    for (const value of oldSet) if (!newSet.has(value)) removed.push(`permissions.${key}:${value}`);
  }
  for (const key of ["storage", "ui", "process"]) {
    const oldValue = before.permissions?.[key] === true;
    const newValue = next.permissions?.[key] === true;
    if (!oldValue && newValue) added.push(`permissions.${key}`);
    if (oldValue && !newValue) removed.push(`permissions.${key}`);
  }
  const increased = [];
  const decreased = [];
  for (const [key, value] of Object.entries(next.resources || {})) {
    const prior = Number(before.resources?.[key]);
    if (!Number.isFinite(prior) || value > prior) increased.push({ resource: key, from: Number.isFinite(prior) ? prior : null, to: value });
    else if (value < prior) decreased.push({ resource: key, from: prior, to: value });
  }
  return { added, removed, increased, decreased };
}

async function readStore(storePath) {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(storePath, "utf8"));
    if (parsed?.schemaVersion === 1 && parsed.approvals && typeof parsed.approvals === "object" && !Array.isArray(parsed.approvals)) return parsed;
  } catch {}
  return { schemaVersion: 1, approvals: {} };
}

async function writeStore(storePath, store) {
  const directory = path.dirname(storePath);
  await fs.promises.mkdir(directory, { recursive: true });
  const tempPath = `${storePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.promises.writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.promises.rename(tempPath, storePath);
}

module.exports = function createModApprovalStore(options = {}) {
  const storePath = path.resolve(String(options.storePath || path.join(process.cwd(), "runtime", "mods", "approvals.json")));
  const now = typeof options.now === "function" ? options.now : Date.now;

  async function getStatus(manifest) {
    const store = await readStore(storePath);
    const current = canonicalGrant(manifest);
    const fingerprint = grantFingerprint(current);
    const approval = store.approvals[manifest.id] || null;
    const approved = approval?.fingerprint === fingerprint;
    return {
      modId: manifest.id,
      version: manifest.version,
      approved,
      needsApproval: !approved,
      fingerprint,
      approvedFingerprint: String(approval?.fingerprint || ""),
      approvedAt: Number(approval?.approvedAt || 0),
      approvedVersion: String(approval?.version || ""),
      diff: diffGrants(approval?.grant || null, current)
    };
  }

  async function approve(manifest, expectedFingerprint) {
    const current = canonicalGrant(manifest);
    const fingerprint = grantFingerprint(current);
    if (expectedFingerprint && expectedFingerprint !== fingerprint) {
      return { ok: false, error: "approval_fingerprint_mismatch", fingerprint };
    }
    const store = await readStore(storePath);
    store.approvals[manifest.id] = {
      fingerprint,
      version: manifest.version,
      approvedAt: Number(now()),
      grant: current
    };
    await writeStore(storePath, store);
    return { ok: true, ...(await getStatus(manifest)) };
  }

  async function revoke(modId) {
    const store = await readStore(storePath);
    const existed = Object.prototype.hasOwnProperty.call(store.approvals, modId);
    delete store.approvals[modId];
    await writeStore(storePath, store);
    return { ok: true, modId, revoked: existed };
  }

  return Object.freeze({ approve, getStatus, revoke });
};

module.exports.canonicalGrant = canonicalGrant;
module.exports.diffGrants = diffGrants;
module.exports.grantFingerprint = grantFingerprint;
