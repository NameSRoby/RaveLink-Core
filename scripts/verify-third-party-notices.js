#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const notices = fs.readFileSync(path.join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
const errors = [];

for (const dependency of [
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.optionalDependencies || {}),
].sort()) {
  if (!notices.includes(`**${dependency}**`))
    errors.push(`missing direct dependency notice: ${dependency}`);
  const dependencyManifest = path.join(root, "node_modules", dependency, "package.json");
  if (!fs.existsSync(dependencyManifest))
    errors.push(`installed dependency metadata missing: ${dependency}`);
}

const featureRoot = path.join(root, "features");
for (const entry of fs.readdirSync(featureRoot, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === "installed") continue;
  const manifest = path.join(featureRoot, entry.name, "ravelink.feature.json");
  if (!fs.existsSync(manifest)) continue;
  const featureNotices = path.join(featureRoot, entry.name, "THIRD_PARTY_NOTICES.md");
  // Song Request bundles provider marks; Twitch Integration uses first-party code only.
  if (entry.name === "song-request" && !fs.existsSync(featureNotices))
    errors.push(`${entry.name} package notice is missing`);
}

if (/\*\*hue-sync\*\*[^\n]+MIT License/i.test(notices))
  errors.push("hue-sync is incorrectly labelled MIT; its installed metadata declares Apache-2.0");
const tidalRoot = path.join(root, "integrations/tidal-desktop");
for (const directory of [tidalRoot, path.join(tidalRoot, "dist")]) {
  for (const file of ["LICENSE.TidaLuna", "LICENSE.RaveLink", "NOTICE.md"])
    if (!fs.existsSync(path.join(directory, file))) errors.push(`TIDAL companion missing ${file}`);
  const license = path.join(directory, "LICENSE.TidaLuna");
  if (
    fs.existsSync(license) &&
    !fs.readFileSync(license, "utf8").startsWith("Microsoft Public License (Ms-PL)")
  )
    errors.push("TIDAL companion license is invalid");
}
if (!notices.includes("**Inrixia/TidaLuna**")) errors.push("TIDAL companion attribution missing");
const spotifyRoot = path.join(root, "integrations/spotify-desktop");
if (fs.existsSync(spotifyRoot)) {
  for (const file of [
    "vendor/spicetify/LICENSE",
    "vendor/spicetify/NOTICE.md",
    "vendor/spicetify/platform-hook.cjs",
    "dist/LICENSE.Spicetify",
    "dist/NOTICE.md",
  ])
    if (!fs.existsSync(path.join(spotifyRoot, file)))
      errors.push(`Spotify companion missing ${file}`);
  const license = path.join(spotifyRoot, "vendor/spicetify/LICENSE");
  if (
    fs.existsSync(license) &&
    !fs.readFileSync(license, "utf8").includes("GNU LESSER GENERAL PUBLIC LICENSE")
  )
    errors.push("Spotify companion license is invalid");
  if (!notices.includes("**Spicetify contributors**"))
    errors.push("Spotify companion attribution missing");
}
if (errors.length) {
  for (const error of errors) console.error(`[THIRD-PARTY] ${error}`);
  process.exit(1);
}
console.log(
  "[THIRD-PARTY] Direct production dependencies and optional package notices are present.",
);
