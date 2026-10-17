/**
 * Sidecar.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#desktop-companions
 */
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const installer = require("./installer.cjs");
const { prepareArchive, readArchive } = require("./archive.cjs");
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const NAME = /^sidecar-[a-f0-9]{24}$/;
function safeAsset(name) {
  return (
    typeof name === "string" &&
    name.length <= 500 &&
    name
      .split("/")
      .every(
        (part) =>
          /^[A-Za-z0-9._@~-]+$/.test(part) &&
          part !== "." &&
          part !== ".." &&
          !part.endsWith(".") &&
          !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part),
      )
  );
}
function inventoryFiles(directory, prefix = "", files = []) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const name = prefix + item.name;
    if (!safeAsset(name) || files.length > 8192 || item.isSymbolicLink())
      throw Error("spotify_sidecar_modified");
    if (item.isDirectory()) inventoryFiles(path.join(directory, item.name), name + "/", files);
    else if (item.isFile()) files.push(name);
    else throw Error("spotify_sidecar_modified");
  }
  return files;
}
function regular(file, maximum = 100 * 1024 * 1024) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maximum)
    throw Error("spotify_sidecar_file_invalid");
  return fs.readFileSync(file);
}
function workspace(input, create = false) {
  const root = path.resolve(input);
  if (/(?:^|[\\/])WindowsApps(?:[\\/]|$)/i.test(root)) throw Error("spotify_sidecar_root_invalid");
  if (create) fs.mkdirSync(root, { recursive: true });
  if (
    fs.realpathSync(root).toLowerCase() !== root.toLowerCase() ||
    !fs.lstatSync(root).isDirectory()
  )
    throw Error("spotify_sidecar_root_invalid");
  return root;
}
function inspect(runtimeRoot, id) {
  if (!NAME.test(id)) throw Error("spotify_sidecar_id_invalid");
  const root = workspace(runtimeRoot),
    directory = path.join(root, id),
    apps = path.join(directory, "Apps");
  if (
    fs.realpathSync(directory).toLowerCase() !== directory.toLowerCase() ||
    fs.realpathSync(apps).toLowerCase() !== apps.toLowerCase()
  )
    throw Error("spotify_sidecar_root_invalid");
  const manifest = JSON.parse(
    regular(path.join(directory, "ravelink-sidecar.json"), 1048576).toString("utf8"),
  );
  if (
    manifest.schemaVersion !== 1 ||
    manifest.id !== id ||
    !manifest.files ||
    !(
      Object.hasOwn(manifest.files, "xpui.spa") || Object.hasOwn(manifest.files, "xpui/index.html")
    ) ||
    Object.keys(manifest.files).length > 8192 ||
    typeof manifest.sourceApps !== "string" ||
    path.basename(manifest.sourceApps) !== "Apps" ||
    !/^[a-f0-9]{64}$/.test(manifest.sourceArchiveHash) ||
    !(manifest.sourceSnapshotHash === null || /^[a-f0-9]{64}$/.test(manifest.sourceSnapshotHash))
  )
    throw Error("spotify_sidecar_manifest_invalid");
  if (
    fs.readdirSync(directory).some((name) => !["Apps", "ravelink-sidecar.json"].includes(name)) ||
    inventoryFiles(apps).some((name) => !Object.hasOwn(manifest.files, name))
  )
    throw Error("spotify_sidecar_modified");
  for (const [name, digest] of Object.entries(manifest.files)) {
    if (
      !safeAsset(name) ||
      !/^[a-f0-9]{64}$/.test(digest) ||
      hash(regular(path.join(apps, name))) !== digest
    )
      throw Error("spotify_sidecar_modified");
  }
  return { ok: true, id, apps, manifest };
}
async function stage(sourceApps, runtimeRoot, options = {}) {
  if (options.allowUnverifiedBuild !== true) throw Error("spotify_live_validation_required");
  const plan = await installer.plan(sourceApps, {
    bundle: options.bundle,
    connection: options.connection,
    allowProtectedRead: true,
  });
  if (
    plan.archiveHash !== options.expectedArchiveHash ||
    plan.snapshotHash !== (options.expectedSnapshotHash || null)
  )
    throw Error("spotify_source_changed");
  const source = path.resolve(sourceApps),
    requestedRoot = path.resolve(runtimeRoot),
    sourceRoot = path.dirname(source).toLowerCase();
  if (
    requestedRoot.toLowerCase() === sourceRoot ||
    requestedRoot.toLowerCase().startsWith(sourceRoot + path.sep)
  )
    throw Error("spotify_sidecar_root_invalid");
  const root = workspace(requestedRoot, true);
  const bundle = installer.bundleData(
    options.bundle || path.join(__dirname, "dist"),
    options.connection ? { ...options.connection, catalog: plan.catalog } : undefined,
  );
  const snapshotPath = path.join(source, "..", "v8_context_snapshot.bin"),
    snapshot = plan.snapshotHash ? regular(snapshotPath, 64 * 1024 * 1024) : undefined;
  const original = regular(path.join(source, "xpui.spa"));
  if (hash(original) !== plan.archiveHash || (snapshot && hash(snapshot) !== plan.snapshotHash))
    throw Error("spotify_source_changed");
  const patched = await prepareArchive(original, bundle.renderer, { snapshot });
  if (hash(patched.archive) !== plan.patchedHash) throw Error("spotify_sidecar_plan_changed");
  const id =
      "sidecar-" +
      hash(
        Buffer.from(
          JSON.stringify(["unpacked-v3", plan.archiveHash, plan.snapshotHash, plan.bundleHash]),
        ),
      ).slice(0, 24),
    directory = path.join(root, id),
    apps = path.join(directory, "Apps");
  if (fs.existsSync(directory)) {
    const existing = inspect(root, id);
    if (existing.manifest.sourceApps !== source) throw Error("spotify_sidecar_source_mismatch");
    return {
      ok: true,
      id,
      apps,
      reused: true,
      protectedSource: plan.protectedSource,
    };
  }
  const files = {},
    content = new Map();
  let total = 0;
  for (const name of fs.readdirSync(source)) {
    if (!/^[A-Za-z0-9._-]+\.(?:spa|html)$/.test(name) || content.size >= 16)
      throw Error("spotify_source_apps_layout_unsupported");
    if (name === "xpui.spa") continue;
    const bytes = regular(path.join(source, name));
    total += bytes.length;
    if (total > 128 * 1024 * 1024) throw Error("spotify_sidecar_size_invalid");
    content.set(name, bytes);
    files[name] = hash(bytes);
  }
  // Spotify's local Apps override also needs the unpacked xpui app. Keep both
  // layouts in this owned directory; never unpack into the installed client.
  for (const row of await readArchive(patched.archive)) {
    if (row.directory) continue;
    const name = "xpui/" + row.name;
    if (!safeAsset(name)) throw Error("spotify_sidecar_asset_invalid");
    total += row.data.length;
    if (total > 128 * 1024 * 1024) throw Error("spotify_sidecar_size_invalid");
    content.set(name, row.data);
    files[name] = hash(row.data);
  }
  // Assemble under an exclusive temporary directory, then publish the completed inventory.
  const temporary = fs.mkdtempSync(path.join(root, ".preparing-")),
    temporaryApps = path.join(temporary, "Apps");
  fs.mkdirSync(temporaryApps);
  // Local Spotify-owned assets live only in runtime, never in the companion release bundle.
  for (const [name, bytes] of content) {
    const target = path.join(temporaryApps, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
  }
  const manifest = {
    schemaVersion: 1,
    id,
    prototype: true,
    sourceApps: source,
    sourceArchiveHash: plan.archiveHash,
    sourceSnapshotHash: plan.snapshotHash,
    bundleHash: plan.bundleHash,
    files,
  };
  fs.writeFileSync(
    path.join(temporary, "ravelink-sidecar.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  fs.renameSync(temporary, directory);
  inspect(root, id);
  return {
    ok: true,
    id,
    apps,
    reused: false,
    protectedSource: plan.protectedSource,
  };
}
function launchPlan(runtimeRoot, id) {
  const record = inspect(runtimeRoot, id),
    source = record.manifest.sourceApps;
  const executable = path.resolve(source, "..", "Spotify.exe");
  regular(executable, 100 * 1024 * 1024);
  if (hash(regular(path.join(source, "xpui.spa"))) !== record.manifest.sourceArchiveHash)
    throw Error("spotify_source_changed");
  if (
    record.manifest.sourceSnapshotHash &&
    hash(regular(path.join(source, "..", "v8_context_snapshot.bin"), 64 * 1024 * 1024)) !==
      record.manifest.sourceSnapshotHash
  )
    throw Error("spotify_source_changed");
  return {
    ok: true,
    executable,
    args: ["--app-directory=" + record.apps],
    requiresClosedSpotify: true,
    prototype: true,
  };
}
function remove(runtimeRoot, id) {
  const record = inspect(runtimeRoot, id),
    directory = path.dirname(record.apps);
  for (const name of Object.keys(record.manifest.files))
    fs.unlinkSync(path.join(record.apps, name));
  const directories = new Set();
  for (const name of Object.keys(record.manifest.files)) {
    let parent = path.dirname(path.join(record.apps, name));
    while (parent !== record.apps) {
      directories.add(parent);
      parent = path.dirname(parent);
    }
  }
  for (const directory of [...directories].sort((a, b) => b.length - a.length))
    fs.rmdirSync(directory);
  fs.rmdirSync(record.apps);
  fs.unlinkSync(path.join(directory, "ravelink-sidecar.json"));
  fs.rmdirSync(directory);
  return { ok: true, removed: true };
}
module.exports = { stage, inspect, launchPlan, remove };
