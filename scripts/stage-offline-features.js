/** Stage only verified authored package inventories, never installed/user state. */
const fs = require("node:fs");
const path = require("node:path");
const {
  verifyFeaturePackageDirectory,
} = require("../src/capabilities/feature-platform/packages/feature-package-integrity");
const {
  OFFICIAL_FEATURE_SOURCES,
} = require("../src/capabilities/feature-platform/packages/official-feature-sources");
async function stageOfflineFeatures(root, destination) {
  for (const { id } of OFFICIAL_FEATURE_SOURCES) {
    const source = path.join(root, "features", id);
    const verified = await verifyFeaturePackageDirectory(source);
    if (!verified.ok || verified.manifest.id !== id) throw Error("invalid_offline_feature:" + id);
    const manifest = structuredClone(verified.manifest);
    delete manifest.integrity.files["README.md"];
    delete manifest.integrity.files["standalone.js"];
    const target = path.join(destination, id);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(
      path.join(target, "ravelink.feature.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    for (const name of Object.keys(manifest.integrity.files)) {
      const output = path.join(target, name);
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.copyFileSync(path.join(source, name), output);
    }
    if (!(await verifyFeaturePackageDirectory(target)).ok)
      throw Error("offline_feature_staging_failed:" + id);
  }
}
module.exports = { stageOfflineFeatures };
if (require.main === module) {
  const root = path.resolve(__dirname, "..");
  const target = path.resolve(process.argv[2] || "");
  if (!target.startsWith(path.join(root, "dist") + path.sep))
    throw Error("Offline feature output must be inside dist.");
  stageOfflineFeatures(root, target).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
