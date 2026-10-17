/**
 * Installer.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#desktop-companions
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const journalName = "ravelink-tidal-install.json";
function regular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("tidal_file_invalid");
}
function resourcesPath(input) {
  const absolute = path.resolve(input),
    actual = fs.realpathSync(absolute);
  if (
    actual.toLowerCase() !== absolute.toLowerCase() ||
    path.basename(actual).toLowerCase() !== "resources" ||
    /(?:^|[\\/])WindowsApps(?:[\\/]|$)/i.test(actual)
  )
    throw new Error("tidal_resources_invalid");
  return actual;
}
function requireStopped(probe) {
  if (probe) {
    if (probe()) throw new Error("Close TIDAL completely (quit from its tray icon), then retry.");
    return;
  }
  if (process.platform !== "win32") throw new Error("tidal_windows_only");
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "if (Get-Process -Name TIDAL -ErrorAction SilentlyContinue) { exit 10 }",
    ],
    { windowsHide: true, timeout: 5000 },
  );
  if (result.status !== 0)
    throw new Error(
      result.status === 10
        ? "Close TIDAL completely (quit from its tray icon), then retry."
        : "tidal_process_check_failed",
    );
}
function checkedBundle(bundle) {
  const inventory = JSON.parse(fs.readFileSync(path.join(bundle, "integrity.json"), "utf8"));
  if (
    !/^0\.1\.[01234567]$/.test(inventory.version) ||
    !inventory.files ||
    !inventory.files["injector.cjs"] ||
    !inventory.files["LICENSE.TidaLuna"]
  )
    throw new Error("tidal_bundle_invalid");
  for (const [file, digest] of Object.entries(inventory.files)) {
    if (!/^[\w.-]+$/.test(file)) throw new Error("tidal_bundle_path_invalid");
    regular(path.join(bundle, file));
    if (hash(path.join(bundle, file)) !== digest) throw new Error("tidal_bundle_integrity_failed");
  }
  return inventory;
}
function removeOwned(directory, inventory) {
  if (!fs.existsSync(directory)) return;
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("tidal_install_modified");
  for (const file of fs.readdirSync(directory)) {
    if (!Object.hasOwn(inventory, file)) throw new Error("tidal_install_modified");
    regular(path.join(directory, file));
    if (hash(path.join(directory, file)) !== inventory[file])
      throw new Error("tidal_install_modified");
  }
  // Exact owned files only. Never recursively remove an unknown app directory.
  for (const file of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, file));
  fs.rmdirSync(directory);
}
function validateUnpackedAlias(alias, target) {
  let stat;
  try {
    stat = fs.lstatSync(alias);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  try {
    if (
      !stat.isSymbolicLink() ||
      fs.realpathSync(alias).toLowerCase() !== fs.realpathSync(target).toLowerCase()
    )
      throw new Error("tidal_unpacked_alias_modified");
  } catch {
    throw new Error("tidal_unpacked_alias_modified");
  }
  return true;
}
function removeUnpackedAlias(alias, target) {
  if (!validateUnpackedAlias(alias, target)) return;
  // Remove only the owned junction, never the original unpacked directory.
  if (process.platform === "win32") fs.rmdirSync(alias);
  else fs.unlinkSync(alias);
}
exports.discover = function discover(localAppData = process.env.LOCALAPPDATA) {
  if (!localAppData) return [];
  const root = path.join(localAppData, "TIDAL");
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((name) => /^app-\d+(?:\.\d+){1,3}$/.test(name))
    .sort((a, b) => b.slice(4).localeCompare(a.slice(4), undefined, { numeric: true }))
    .map((name) => path.join(root, name, "resources"))
    .filter((file) => fs.existsSync(file));
};
exports.inspect = function inspect(input) {
  const resources = resourcesPath(input),
    journal = path.join(resources, journalName);
  let version = "";
  if (fs.existsSync(journal)) {
    try {
      version = String(JSON.parse(fs.readFileSync(journal, "utf8")).version || "").slice(0, 20);
    } catch {}
  }
  return {
    resources,
    installed: fs.existsSync(journal),
    version,
    foreignLoader:
      fs.existsSync(path.join(resources, "original.asar")) ||
      (fs.existsSync(path.join(resources, "app")) && !fs.existsSync(journal)),
    originalAvailable: fs.existsSync(path.join(resources, "app.asar")),
  };
};
exports.install = function install({
  resources: input,
  pairingFile,
  coreUrl = "http://127.0.0.1:5050",
  bundle = path.join(__dirname, "dist"),
  probe,
}) {
  requireStopped(probe);
  const resources = resourcesPath(input);
  const original = path.join(resources, "app.asar"),
    backup = path.join(resources, "ravelink-original.asar");
  const unpacked = original + ".unpacked",
    unpackedAlias = backup + ".unpacked";
  const app = path.join(resources, "app"),
    stage = path.join(resources, ".ravelink-tidal-stage"),
    journal = path.join(resources, journalName);
  if (
    [backup, unpackedAlias, app, stage, journal, path.join(resources, "original.asar")].some(
      (file) => fs.existsSync(file),
    )
  )
    throw new Error("Existing loader or incomplete install found; uninstall/review it first.");
  const hasUnpacked = fs.existsSync(unpacked);
  if (
    hasUnpacked &&
    (!fs.lstatSync(unpacked).isDirectory() || fs.lstatSync(unpacked).isSymbolicLink())
  )
    throw new Error("tidal_unpacked_directory_invalid");
  regular(original);
  if (fs.statSync(original).size < 16) throw new Error("tidal_archive_invalid");
  const tidalManifest = require("./archive-metadata.cjs")(original);
  const pairing = path.resolve(pairingFile);
  regular(pairing);
  // Validate native configuration without saving the scoped token into TIDAL.
  require("./native-bridge.cjs").createNativeBridge({
    coreUrl,
    pairingFile: pairing,
  });
  const inventory = checkedBundle(bundle);
  fs.mkdirSync(stage);
  let renamedOriginal = false,
    activated = false,
    linkedUnpacked = false;
  try {
    for (const file of Object.keys(inventory.files))
      fs.copyFileSync(path.join(bundle, file), path.join(stage, file), fs.constants.COPYFILE_EXCL);
    // Preserve the app identity/version used by Electron and TIDAL's own updater.
    fs.writeFileSync(
      path.join(stage, "package.json"),
      JSON.stringify({ ...tidalManifest, main: "injector.cjs" }) + "\n",
    );
    fs.writeFileSync(
      path.join(stage, "config.json"),
      JSON.stringify({ coreUrl, pairingFile: pairing }) + "\n",
      { flag: "wx" },
    );
    const owned = Object.fromEntries(
      fs.readdirSync(stage).map((file) => [file, hash(path.join(stage, file))]),
    );
    const record = {
      owner: "ravelink-tidal-companion",
      version: inventory.version,
      originalHash: hash(original),
      unpackedAlias: hasUnpacked,
      files: owned,
    };
    fs.writeFileSync(journal, JSON.stringify(record, null, 2) + "\n", {
      flag: "wx",
    });
    if (hasUnpacked) {
      fs.symlinkSync(unpacked, unpackedAlias, process.platform === "win32" ? "junction" : "dir");
      linkedUnpacked = true;
    }
    fs.renameSync(original, backup);
    renamedOriginal = true;
    fs.renameSync(stage, app);
    activated = true;
    return { ok: true, installed: true, resources, version: inventory.version };
  } catch (error) {
    // Keep the journal and backup if rollback is interrupted or files were changed.
    try {
      if (activated) removeOwned(app, JSON.parse(fs.readFileSync(journal, "utf8")).files);
      if (renamedOriginal && !fs.existsSync(original)) fs.renameSync(backup, original);
      if (linkedUnpacked) removeUnpackedAlias(unpackedAlias, unpacked);
      if (fs.existsSync(journal)) {
        removeOwned(stage, JSON.parse(fs.readFileSync(journal, "utf8")).files);
        fs.unlinkSync(journal);
      } else {
        const files = Object.fromEntries(
          fs.readdirSync(stage).map((file) => [file, hash(path.join(stage, file))]),
        );
        removeOwned(stage, files);
      }
    } catch {
      /* Recover with uninstall; do not erase uncertain ownership. */
    }
    throw error;
  }
};
exports.uninstall = function uninstall({ resources: input, probe }) {
  requireStopped(probe);
  const resources = resourcesPath(input),
    journal = path.join(resources, journalName);
  regular(journal);
  const record = JSON.parse(fs.readFileSync(journal, "utf8"));
  if (
    record.owner !== "ravelink-tidal-companion" ||
    !record.files ||
    !/^[a-f0-9]{64}$/.test(record.originalHash)
  )
    throw new Error("tidal_install_record_invalid");
  const backup = path.join(resources, "ravelink-original.asar"),
    original = path.join(resources, "app.asar");
  if (record.unpackedAlias === true)
    validateUnpackedAlias(backup + ".unpacked", original + ".unpacked");
  // Validate everything before changing anything, including update collisions.
  const archive = fs.existsSync(backup) ? backup : original;
  regular(archive);
  if (hash(archive) !== record.originalHash || (fs.existsSync(backup) && fs.existsSync(original)))
    throw new Error("TIDAL was updated or its archive changed; review before restoring.");
  for (const directory of ["app", ".ravelink-tidal-stage"]) {
    const target = path.join(resources, directory);
    if (!fs.existsSync(target)) continue;
    if (fs.lstatSync(target).isSymbolicLink()) throw new Error("tidal_install_modified");
    for (const file of fs.readdirSync(target)) {
      regular(path.join(target, file));
      if (record.files[file] !== hash(path.join(target, file)))
        throw new Error("tidal_install_modified");
    }
  }
  for (const directory of ["app", ".ravelink-tidal-stage"])
    removeOwned(path.join(resources, directory), record.files);
  if (fs.existsSync(backup)) fs.renameSync(backup, original);
  if (record.unpackedAlias === true)
    removeUnpackedAlias(backup + ".unpacked", original + ".unpacked");
  fs.unlinkSync(journal);
  return { ok: true, installed: false, resources };
};
