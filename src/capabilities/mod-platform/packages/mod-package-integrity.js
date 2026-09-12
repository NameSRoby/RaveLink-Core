// [TITLE] Module: capabilities/mod-platform/packages/mod-package-integrity.js
// [TITLE] Purpose: scan and cryptographically verify an untrusted mod package directory
// [TITLE] Functionality Index:
// [TITLE] - reject links, unsafe paths, case collisions, and oversized package trees
// [TITLE] - validate the root manifest before accepting payload files
// [TITLE] - require a complete exact SHA-256 inventory with no undeclared files

const fs = require("node:fs");
const { validateManifestV1 } = require("../contracts/mod-manifest-v1");
const {
  DEFAULT_LIMITS,
  hashFileSha256,
  scanPackageDirectory,
  verifyIntegrityInventory
} = require("../../../shared/packages/package-directory-integrity");

const MANIFEST_NAME = "ravelink.mod.json";
async function verifyPackageDirectory(rootPath, options = {}) {
  const scanned = await scanPackageDirectory(rootPath, options.limits);
  if (!scanned.ok) return scanned;
  const manifestRow = scanned.files.find(row => row.path === MANIFEST_NAME);
  if (!manifestRow) return { ok: false, error: "manifest_missing" };
  if (manifestRow.bytes > scanned.limits.maxManifestBytes) return { ok: false, error: "manifest_too_large" };
  let rawManifest;
  try { rawManifest = JSON.parse(await fs.promises.readFile(manifestRow.absolute, "utf8")); }
  catch { return { ok: false, error: "manifest_invalid_json" }; }
  const validation = validateManifestV1(rawManifest, { modApiMajor: options.modApiMajor || 1 });
  if (!validation.ok) return { ok: false, error: "manifest_invalid", manifestErrors: validation.errors };
  const manifest = validation.value;
  const integrity = await verifyIntegrityInventory(scanned, MANIFEST_NAME, manifest.integrity);
  if (!integrity.ok) return integrity;
  return {
    ok: true,
    root: scanned.root,
    manifest,
    files: scanned.files.map(row => ({ path: row.path, bytes: row.bytes })),
    totalBytes: scanned.totalBytes
  };
}

module.exports = {
  DEFAULT_LIMITS,
  MANIFEST_NAME,
  hashFileSha256,
  scanPackageDirectory,
  verifyPackageDirectory
};
