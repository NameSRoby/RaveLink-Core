#!/usr/bin/env node

const path = require("node:path");
const createFeaturePackageManager = require("../src/capabilities/feature-platform/packages/feature-package-manager");
const { OFFICIAL_FEATURE_SOURCES } = require("../src/capabilities/feature-platform/packages/official-feature-sources");

const OFFICIAL_IDS = new Set(OFFICIAL_FEATURE_SOURCES.map(row => row.id));

function selectedFeatureIds(values) {
  const ids = [...new Set((values || []).map(value => String(value || "").trim()).filter(Boolean))];
  if (!ids.length || ids.some(id => !OFFICIAL_IDS.has(id))) throw new Error("invalid_feature_selection");
  return ids;
}

async function installSelectedFeatures(options = {}) {
  const rootDir = path.resolve(options.rootDir || path.join(__dirname, ".."));
  const featureIds = selectedFeatureIds(options.featureIds);
  const manager = options.manager || createFeaturePackageManager({
    installedRoot: path.join(rootDir, "features", "installed"),
    packageRoots: [],
    remoteSources: OFFICIAL_FEATURE_SOURCES,
    runtimeRoot: path.join(rootDir, "runtime", "features")
  });
  const catalog = await manager.listAvailable();
  const available = new Map((catalog.features || []).map(row => [row.id, row]));
  const results = [];
  for (const featureId of featureIds) {
    const row = available.get(featureId);
    if (!row) throw new Error(`feature_package_not_available:${featureId}`);
    if (row.installed && !row.updateAvailable) {
      results.push({ ok: true, featureId, operation: "already_current", version: row.installedVersion });
      continue;
    }
    const result = row.installed ? await manager.update(featureId) : await manager.install(featureId);
    if (!result?.ok) throw new Error(`${String(result?.error || "feature_install_failed").slice(0, 80)}:${featureId}`);
    results.push({ ok: true, featureId, operation: row.installed ? "updated" : "installed", version: String(result.version || row.version || "") });
  }
  return results;
}

async function main() {
  try {
    const results = await installSelectedFeatures({ featureIds: process.argv.slice(2) });
    for (const row of results) process.stdout.write(`[FEATURE SETUP] ${row.featureId} ${row.operation}\n`);
  } catch (error) {
    process.stderr.write(`[FEATURE SETUP] ${String(error?.message || "feature_install_failed").slice(0, 160)}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) void main();

module.exports = { installSelectedFeatures, selectedFeatureIds };
