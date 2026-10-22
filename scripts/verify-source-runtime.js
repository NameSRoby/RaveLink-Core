/** Verify the downloaded production dependency graph before installing it. */
const fs = require("node:fs");
const path = require("node:path");

function verify(source, runtime) {
  const readLock = (root) =>
    JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8")).packages;
  const expected = readLock(source);
  const supplied = readLock(runtime);
  for (const [name, entry] of Object.entries(expected)) {
    if (!name || entry.dev) continue;
    const actual = supplied[name];
    if (!actual || actual.version !== entry.version || actual.integrity !== entry.integrity)
      throw new Error(`Runtime dependency differs from source lock: ${name}`);
    const installed = path.join(runtime, name, "package.json");
    if (!fs.existsSync(installed) && entry.optional) continue;
    if (JSON.parse(fs.readFileSync(installed, "utf8")).version !== entry.version)
      throw new Error(`Runtime dependency is missing or incompatible: ${name}`);
  }
  for (const file of [
    "runtime/RaveLink-Core-Node.exe",
    "runtime/music-to-light/cargo/release/ravelink-audio-probe.exe",
    "runtime/NODE-LICENSE.txt",
  ]) {
    if (!fs.statSync(path.join(runtime, file)).isFile()) throw new Error(`Missing ${file}`);
  }
}

module.exports = { verify };
if (require.main === module) {
  try {
    verify(...process.argv.slice(2));
  } catch (error) {
    console.error(`[SETUP] ${error.message}`);
    process.exitCode = 1;
  }
}
