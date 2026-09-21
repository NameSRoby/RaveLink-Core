#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const notices = fs.readFileSync(path.join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
const errors = [];

for (const dependency of [...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.optionalDependencies || {})].sort()) {
  if (!notices.includes(`**${dependency}**`)) errors.push(`missing direct dependency notice: ${dependency}`);
  const dependencyManifest = path.join(root, "node_modules", dependency, "package.json");
  if (!fs.existsSync(dependencyManifest)) errors.push(`installed dependency metadata missing: ${dependency}`);
}

const featureRoot = path.join(root, "features");
for (const entry of fs.readdirSync(featureRoot, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === "installed") continue;
  const manifest = path.join(featureRoot, entry.name, "ravelink.feature.json");
  if (!fs.existsSync(manifest)) continue;
  const featureNotices = path.join(featureRoot, entry.name, "THIRD_PARTY_NOTICES.md");
  if (entry.name === "clip-studio" && !fs.existsSync(featureNotices)) errors.push("Clip Studio package notice is missing");
}

if (/\*\*hue-sync\*\*[^\n]+MIT License/i.test(notices)) errors.push("hue-sync is incorrectly labelled MIT; its installed metadata declares Apache-2.0");
if (errors.length) {
  for (const error of errors) console.error(`[THIRD-PARTY] ${error}`);
  process.exit(1);
}
console.log("[THIRD-PARTY] Direct production dependencies and Clip Studio notices are present.");
