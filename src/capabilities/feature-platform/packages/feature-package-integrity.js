const fs = require("node:fs");
const { scanPackageDirectory, verifyIntegrityInventory } = require("../../../shared/packages/package-directory-integrity");
const { validateFeatureManifestV1 } = require("../contracts/feature-manifest-v1");

const MANIFEST_NAME = "ravelink.feature.json";

async function verifyFeaturePackageDirectory(rootPath, options = {}) {
  const scanned = await scanPackageDirectory(rootPath, options.limits);
  if (!scanned.ok) return scanned;
  const manifestRow = scanned.files.find(row => row.path === MANIFEST_NAME);
  if (!manifestRow) return { ok: false, error: "feature_manifest_missing" };
  if (manifestRow.bytes > scanned.limits.maxManifestBytes) return { ok: false, error: "feature_manifest_too_large" };
  let input;
  try { input = JSON.parse(await fs.promises.readFile(manifestRow.absolute, "utf8")); }
  catch { return { ok: false, error: "feature_manifest_invalid_json" }; }
  const validated = validateFeatureManifestV1(input);
  if (!validated.ok) return { ok: false, error: "feature_manifest_invalid", manifestErrors: validated.errors };
  const integrity = await verifyIntegrityInventory(scanned, MANIFEST_NAME, validated.value.integrity);
  if (!integrity.ok) return integrity;
  return { ok: true, root: scanned.root, manifest: validated.value, files: scanned.files.map(row => ({ path: row.path, bytes: row.bytes })), totalBytes: scanned.totalBytes };
}

module.exports = { MANIFEST_NAME, verifyFeaturePackageDirectory };
