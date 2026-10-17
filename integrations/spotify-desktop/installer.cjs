/**
 * Installer.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#desktop-companions
 */
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { prepareArchive } = require("./archive.cjs");
const JOURNAL = ".ravelink-spotify-install.json",
  BACKUP = ".ravelink-spotify-original.spa";
const digest = (data) => crypto.createHash("sha256").update(data).digest("hex");
const exists = (file) => {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};
function regular(file, limit) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit)
    throw Error("spotify_file_invalid");
  return file;
}
function rootPath(input, protectedRead = false) {
  const root = path.resolve(input),
    actual = fs.realpathSync(root);
  if (
    path.basename(root).toLowerCase() !== "apps" ||
    actual.toLowerCase() !== root.toLowerCase() ||
    !fs.statSync(root).isDirectory() ||
    (!protectedRead && /(?:^|[\\/])WindowsApps(?:[\\/]|$)/i.test(root))
  )
    throw Error("spotify_apps_path_invalid");
  if (exists(path.join(root, "xpui"))) throw Error("spotify_unpacked_client_detected");
  regular(path.join(root, "xpui.spa"), 96 * 1024 * 1024);
  return root;
}
function stopped(options) {
  if (typeof options.isRunning === "function") {
    if (options.isRunning() !== false) throw Error("spotify_close_client_required");
    return;
  }
  if (process.platform !== "win32") throw Error("spotify_windows_only");
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "if (Get-Process -Name Spotify -ErrorAction SilentlyContinue) { exit 10 }",
    ],
    { windowsHide: true, timeout: 5000 },
  );
  if (result.status !== 0)
    throw Error(
      result.status === 10 ? "spotify_close_client_required" : "spotify_process_check_failed",
    );
}
function bundleData(bundle, connection) {
  const manifestPath = regular(path.join(bundle, "integrity.json"), 16384),
    inventory = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (
    inventory.version !== "0.1.0-prototype" ||
    inventory.installable !== false ||
    !inventory.files ||
    !inventory.files["renderer.js"] ||
    !inventory.files["LICENSE.Spicetify"] ||
    !inventory.files["NOTICE.md"]
  )
    throw Error("spotify_bundle_invalid");
  for (const [name, hash] of Object.entries(inventory.files)) {
    if (!/^[A-Za-z0-9._-]+$/.test(name) || !/^[a-f0-9]{64}$/.test(hash))
      throw Error("spotify_bundle_invalid");
    const file = regular(path.join(bundle, name), 1024 * 1024);
    if (digest(fs.readFileSync(file)) !== hash) throw Error("spotify_bundle_integrity_failed");
  }
  const expected = new Set([...Object.keys(inventory.files), "integrity.json"]);
  if (fs.readdirSync(bundle).some((name) => !expected.has(name)))
    throw Error("spotify_bundle_unexpected_file");
  let renderer = fs.readFileSync(path.join(bundle, "renderer.js"));
  let configuration = "";
  if (connection) {
    const url = new URL(connection.coreUrl);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      !/^[a-f0-9]{64}$/.test(connection.token || "")
    )
      throw Error("spotify_pairing_invalid");
    const catalog = {};
    for (const name of ["searchTracks", "getTrack"])
      if (/^[a-f0-9]{64}$/.test(connection.catalog?.[name] || ""))
        catalog[name] = connection.catalog[name];
    configuration = JSON.stringify({
      coreUrl: url.origin,
      token: connection.token,
      catalog,
    });
    renderer = Buffer.concat([
      Buffer.from("globalThis.__ravelinkSpotifyConfig=" + configuration + ";\n"),
      renderer,
    ]);
  }
  return {
    inventory,
    renderer,
    bundleHash: digest(Buffer.concat([fs.readFileSync(manifestPath), Buffer.from(configuration)])),
  };
}
function journal(root) {
  const file = path.join(root, JOURNAL);
  if (!exists(file)) return null;
  const value = JSON.parse(fs.readFileSync(regular(file, 16384), "utf8"));
  if (
    value.schemaVersion !== 1 ||
    value.version !== "0.1.0-prototype" ||
    !["prepared", "installed"].includes(value.phase) ||
    !["originalHash", "patchedHash", "bundleHash"].every((key) => /^[a-f0-9]{64}$/.test(value[key]))
  )
    throw Error("spotify_journal_invalid");
  return value;
}
function atomic(file, data) {
  const temporary = file + ".tmp-" + crypto.randomBytes(8).toString("hex");
  try {
    fs.writeFileSync(temporary, data, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    if (exists(temporary)) fs.unlinkSync(regular(temporary, 100 * 1024 * 1024));
  }
}
function status(appsPath, options = {}) {
  const root = rootPath(appsPath, options.allowProtectedRead === true),
    stored = journal(root),
    hash = digest(fs.readFileSync(path.join(root, "xpui.spa")));
  if (!stored)
    return {
      ok: true,
      available: true,
      installed: false,
      prototype: true,
      archiveHash: hash,
    };
  const backup = path.join(root, BACKUP);
  const backupValid =
    exists(backup) &&
    digest(fs.readFileSync(regular(backup, 96 * 1024 * 1024))) === stored.originalHash;
  return {
    ok: true,
    available: true,
    installed: hash === stored.patchedHash,
    prototype: true,
    recoverable: backupValid && [stored.originalHash, stored.patchedHash].includes(hash),
    changed: ![stored.originalHash, stored.patchedHash].includes(hash),
    archiveHash: hash,
  };
}
async function plan(appsPath, options = {}) {
  const root = rootPath(appsPath, options.allowProtectedRead === true);
  if (exists(path.join(root, JOURNAL)) || exists(path.join(root, BACKUP)))
    throw Error("spotify_installation_already_present");
  const original = fs.readFileSync(path.join(root, "xpui.spa"));
  const snapshotPath = path.join(root, "..", "v8_context_snapshot.bin"),
    snapshot = exists(snapshotPath)
      ? fs.readFileSync(regular(snapshotPath, 64 * 1024 * 1024))
      : undefined;
  const catalog = options.connection
    ? await require("./catalog-documents.cjs")(original, snapshot)
    : {};
  const bundle = bundleData(
    options.bundle || path.join(__dirname, "dist"),
    options.connection ? { ...options.connection, catalog } : undefined,
  );
  const result = await prepareArchive(original, bundle.renderer, { snapshot });
  return {
    ok: true,
    prototype: true,
    catalog,
    archiveHash: digest(original),
    patchedHash: digest(result.archive),
    bundleHash: bundle.bundleHash,
    changes: result.changes,
    platformAsset: result.platformAsset,
    snapshotHash: result.snapshotExtracted ? digest(snapshot) : null,
    protectedSource: /(?:^|[\\/])WindowsApps(?:[\\/]|$)/i.test(root),
  };
}
async function install(appsPath, options = {}) {
  if (options.allowUnverifiedBuild !== true) throw Error("spotify_live_validation_required");
  stopped(options);
  const root = rootPath(appsPath);
  if (exists(path.join(root, JOURNAL)) || exists(path.join(root, BACKUP)))
    throw Error("spotify_installation_already_present");
  const bundle = bundleData(options.bundle || path.join(__dirname, "dist"), options.connection),
    target = path.join(root, "xpui.spa");
  const original = fs.readFileSync(target),
    originalHash = digest(original);
  if (
    !/^[a-f0-9]{64}$/.test(options.expectedArchiveHash || "") ||
    options.expectedArchiveHash !== originalHash
  )
    throw Error("spotify_archive_changed");
  const snapshotPath = path.join(root, "..", "v8_context_snapshot.bin"),
    snapshot = exists(snapshotPath)
      ? fs.readFileSync(regular(snapshotPath, 64 * 1024 * 1024))
      : undefined;
  const result = await prepareArchive(original, bundle.renderer, { snapshot });
  const snapshotHash = result.snapshotExtracted ? digest(snapshot) : null;
  if (snapshotHash && options.expectedSnapshotHash !== snapshotHash)
    throw Error("spotify_snapshot_changed");
  stopped(options);
  rootPath(root);
  if (digest(fs.readFileSync(target)) !== originalHash) throw Error("spotify_archive_changed");
  if (
    snapshotHash &&
    digest(fs.readFileSync(regular(snapshotPath, 64 * 1024 * 1024))) !== snapshotHash
  )
    throw Error("spotify_snapshot_changed");
  const backup = path.join(root, BACKUP),
    record = {
      schemaVersion: 1,
      version: "0.1.0-prototype",
      phase: "prepared",
      originalHash,
      patchedHash: digest(result.archive),
      bundleHash: bundle.bundleHash,
    };
  // The backup is created exclusively. A prepared journal can recover an interrupted commit.
  fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL);
  if (digest(fs.readFileSync(regular(backup, 96 * 1024 * 1024))) !== originalHash)
    throw Error("spotify_backup_integrity_failed");
  fs.writeFileSync(path.join(root, JOURNAL), JSON.stringify(record, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  if (digest(fs.readFileSync(target)) !== originalHash) throw Error("spotify_archive_changed");
  atomic(target, result.archive);
  record.phase = "installed";
  atomic(path.join(root, JOURNAL), JSON.stringify(record, null, 2) + "\n");
  return {
    ok: true,
    installed: true,
    prototype: true,
    changes: result.changes,
  };
}
function uninstall(appsPath, options = {}) {
  stopped(options);
  const root = rootPath(appsPath),
    stored = journal(root);
  if (!stored) throw Error("spotify_installation_not_found");
  const target = path.join(root, "xpui.spa"),
    backup = path.join(root, BACKUP),
    currentHash = digest(fs.readFileSync(target));
  if (![stored.originalHash, stored.patchedHash].includes(currentHash))
    throw Error("spotify_archive_changed");
  const original = fs.readFileSync(regular(backup, 96 * 1024 * 1024));
  if (digest(original) !== stored.originalHash) throw Error("spotify_backup_integrity_failed");
  stopped(options);
  rootPath(root);
  if (digest(fs.readFileSync(target)) !== currentHash) throw Error("spotify_archive_changed");
  if (currentHash !== stored.originalHash) atomic(target, original);
  // Only exact owned files are removed; unrelated app assets are never enumerated for deletion.
  fs.unlinkSync(backup);
  fs.unlinkSync(regular(path.join(root, JOURNAL), 16384));
  return { ok: true, installed: false, restored: true };
}
function discover(appData = process.env.APPDATA) {
  if (!appData) return [];
  const root = path.join(appData, "Spotify", "Apps");
  try {
    rootPath(root);
    return [root];
  } catch {
    return [];
  }
}
module.exports = { plan, install, uninstall, status, discover, bundleData };
