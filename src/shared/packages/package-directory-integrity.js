const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_LIMITS = Object.freeze({
  maxFiles: 2048,
  maxPackageBytes: 32 * 1024 * 1024,
  maxFileBytes: 8 * 1024 * 1024,
  maxDepth: 16,
  maxManifestBytes: 65536
});

function isSafePackagePath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0")) return false;
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  const normalized = path.posix.normalize(value);
  return normalized === value && normalized !== "." && !normalized.startsWith("../") && !normalized.includes("/../");
}

function boundedLimits(overrides = {}) {
  const out = {};
  for (const [key, fallback] of Object.entries(DEFAULT_LIMITS)) {
    const value = Number(overrides[key]);
    out[key] = Number.isInteger(value) && value > 0 ? Math.min(value, fallback) : fallback;
  }
  return out;
}

async function hashFileSha256(filePath) {
  return await new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", chunk => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function scanPackageDirectory(rootPath, limitOverrides = {}) {
  const limits = boundedLimits(limitOverrides);
  const root = path.resolve(String(rootPath || ""));
  let rootStat;
  try { rootStat = await fs.promises.lstat(root); } catch { return { ok: false, error: "package_root_missing" }; }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return { ok: false, error: "package_root_invalid" };
  const files = [];
  const caseKeys = new Set();
  let totalBytes = 0;

  async function walk(directory, depth) {
    if (depth > limits.maxDepth) throw new Error("package_depth_limit");
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (!isSafePackagePath(relative)) throw new Error("package_unsafe_path");
      const stat = await fs.promises.lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error("package_link_not_allowed");
      if (stat.isDirectory()) { await walk(absolute, depth + 1); continue; }
      if (!stat.isFile()) throw new Error("package_special_file_not_allowed");
      const caseKey = relative.toLowerCase();
      if (caseKeys.has(caseKey)) throw new Error("package_case_collision");
      caseKeys.add(caseKey);
      if (stat.size > limits.maxFileBytes) throw new Error("package_file_too_large");
      totalBytes += stat.size;
      if (totalBytes > limits.maxPackageBytes) throw new Error("package_size_limit");
      files.push({ path: relative, absolute, bytes: stat.size });
      if (files.length > limits.maxFiles) throw new Error("package_file_count_limit");
    }
  }

  try { await walk(root, 0); } catch (error) { return { ok: false, error: String(error?.message || error) }; }
  return { ok: true, root, files, totalBytes, limits };
}

async function verifyIntegrityInventory(scanned, manifestName, integrity) {
  const payload = scanned.files.filter(row => row.path !== manifestName);
  const declared = integrity?.files && typeof integrity.files === "object" ? integrity.files : {};
  const declaredPaths = Object.keys(declared).sort();
  const actualPaths = payload.map(row => row.path).sort();
  const undeclared = actualPaths.filter(file => !Object.prototype.hasOwnProperty.call(declared, file));
  const missing = declaredPaths.filter(file => !actualPaths.includes(file));
  if (undeclared.length || missing.length) {
    return { ok: false, error: "integrity_inventory_mismatch", undeclared: undeclared.slice(0, 20), missing: missing.slice(0, 20) };
  }
  for (const row of payload) {
    if (await hashFileSha256(row.absolute) !== declared[row.path]) {
      return { ok: false, error: "integrity_hash_mismatch", file: row.path };
    }
  }
  return { ok: true };
}

module.exports = { DEFAULT_LIMITS, boundedLimits, hashFileSha256, isSafePackagePath, scanPackageDirectory, verifyIntegrityInventory };
