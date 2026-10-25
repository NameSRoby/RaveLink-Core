/** Offline first-run checks using the bundled Node runtime. No capture, pairing,
 * account connection or application settings are created by these checks. */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

function checkInstallation({ root = path.resolve(__dirname, ".."), music = true } = {}) {
  const checks = [];
  const check = (name, work) => {
    try {
      work();
      checks.push({ name, ok: true });
    } catch (error) {
      checks.push({ name, ok: false, error: error.message });
    }
  };
  check("Bundled runtime", () => {
    if (
      process.platform !== "win32" ||
      process.arch !== "x64" ||
      Number(process.versions.node.split(".")[0]) < 24
    )
      throw Error("Use the bundled Windows x64 Node 24 runtime.");
  });
  check("Production dependencies", () => {
    const packages = JSON.parse(
      fs.readFileSync(path.join(root, "package-lock.json"), "utf8"),
    ).packages;
    for (const [name, info] of Object.entries(packages)) {
      if (!name || info.dev || info.optional) continue;
      const file = path.join(root, name, "package.json");
      if (
        !fs.existsSync(file) ||
        JSON.parse(fs.readFileSync(file, "utf8")).version !== info.version
      )
        throw Error("Missing or incompatible dependency: " + name);
    }
    require(require.resolve("express", { paths: [root] }));
  });
  check("Hue Entertainment crypto", () => {
    require(require.resolve("node-dtls-client", { paths: [root] }));
    const crypto = require("node:crypto");
    if (!crypto.getCiphers().includes("aes-128-ccm"))
      throw Error("Bundled crypto support is incomplete.");
  });
  check("Writable application data", () => {
    const dir = path.join(root, "runtime", "logs");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `.setup-write-${process.pid}`);
    fs.writeFileSync(file, "test", { flag: "wx" });
    fs.unlinkSync(file);
  });
  if (music)
    check("Music-to-Light capture helper", () => {
      if (Number(os.release().split(".")[2]) < 20348)
        throw Error(
          "Application audio capture needs Windows build 20348 or later; use Windows 11.",
        );
      const helper = path.join(
        root,
        "runtime/music-to-light/cargo/release/ravelink-audio-probe.exe",
      );
      const result = spawnSync(helper, ["--installation-check"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5000,
      });
      if (
        result.error ||
        result.status === null ||
        result.status === 0 ||
        !String(result.stdout + result.stderr).includes('"code":"invalid_arguments"')
      )
        throw Error(
          "Capture helper could not load. Repair this installation; no audio was captured.",
        );
    });
  return { ok: checks.every((row) => row.ok), checks };
}
module.exports = { checkInstallation };
if (require.main === module) {
  const result = checkInstallation({ music: !process.argv.includes("--no-music") });
  const text =
    result.checks
      .map((row) => `${row.ok ? "OK" : "FAILED"}: ${row.name}${row.error ? ": " + row.error : ""}`)
      .join("\n") + "\n";
  try {
    fs.writeFileSync(path.resolve(__dirname, "../runtime/logs/setup-check.log"), text);
  } catch {}
  process.stdout.write(text);
  process.exitCode = result.ok ? 0 : 1;
}
