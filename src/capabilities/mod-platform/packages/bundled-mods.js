/** Default approval applies only to reviewed application-bundled adapters.
 * Source inventory, identity and capability scope must match exactly. */
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { verifyPackageDirectory } = require("./mod-package-integrity");
module.exports = function bundledMods({ rootDir, modsRoot, runtimeRoot, approvalStore }) {
  const file = path.join(runtimeRoot, "bundled.json");
  const ownershipFile = path.join(runtimeRoot, "bundled-owned.json");
  const specs = [
    ["twitch-clips", "ravelink.twitch-clips", "twitch.clips.host.v1", "stream.clip.v1"],
  ];
  let preferences = {};
  let owned = {};
  try {
    const stat = fs.lstatSync(file);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.size < 2048)
      preferences = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {}
  try {
    const stat = fs.lstatSync(ownershipFile);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.size < 2048)
      owned = JSON.parse(fs.readFileSync(ownershipFile, "utf8"));
  } catch {}
  if (!preferences || typeof preferences !== "object" || Array.isArray(preferences))
    preferences = {};
  if (!owned || typeof owned !== "object" || Array.isArray(owned)) owned = {};
  const digest = (manifest) =>
    crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  function saveOwnership(id, manifest) {
    owned[id] = digest(manifest);
    fs.mkdirSync(path.dirname(ownershipFile), { recursive: true });
    fs.writeFileSync(ownershipFile + ".tmp", JSON.stringify(owned) + "\n", { mode: 0o600 });
    fs.renameSync(ownershipFile + ".tmp", ownershipFile);
  }
  async function managedUpdate(id, source, target, installed, manifest) {
    // A user-modified tree cannot be replaced just because its mod ID matches.
    if (owned[id] !== digest(installed.manifest)) return false;
    if (path.relative(path.resolve(modsRoot), path.resolve(target)) !== id)
      throw Error("bundled_target_invalid");
    const token = crypto.randomBytes(6).toString("hex");
    const stage = path.join(modsRoot, ".bundled-stage-" + id + "-" + token);
    const backup = path.join(modsRoot, ".bundled-backup-" + id + "-" + token);
    fs.cpSync(source, stage, {
      recursive: true,
      errorOnExist: true,
      force: false,
      dereference: false,
    });
    const checked = await verifyPackageDirectory(stage);
    if (!checked.ok || digest(checked.manifest) !== digest(manifest)) return false;
    fs.renameSync(target, backup);
    try {
      fs.renameSync(stage, target);
    } catch (error) {
      fs.renameSync(backup, target);
      throw error;
    }
    return true;
  }
  function preference(id, enabled) {
    if (!specs.some((s) => s[1] === id)) return;
    preferences[id] = enabled === true;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + ".tmp", JSON.stringify(preferences) + "\n", { mode: 0o600 });
    fs.renameSync(file + ".tmp", file);
  }
  async function prepare() {
    const enable = [],
      results = [];
    for (const [slug, id, consumed, provided] of specs) {
      const source = path.join(rootDir, "packages", "bundled-mods", slug);
      const verified = await verifyPackageDirectory(source);
      const manifest = verified.manifest,
        permissions = manifest?.permissions;
      if (
        !verified.ok ||
        manifest.id !== id ||
        manifest.publisher !== "ravelink" ||
        manifest.consumes.length !== 1 ||
        manifest.consumes[0] !== consumed ||
        manifest.provides.length !== 1 ||
        manifest.provides[0] !== provided ||
        permissions.network.length ||
        permissions.secrets.length ||
        permissions.hardware.length ||
        permissions.process ||
        permissions.ui ||
        permissions.storage
      ) {
        results.push({ id, ok: false, code: "bundled_mod_invalid" });
        continue;
      }
      const target = path.join(modsRoot, id);
      if (!fs.existsSync(target)) {
        fs.mkdirSync(modsRoot, { recursive: true });
        fs.cpSync(source, target, {
          recursive: true,
          errorOnExist: true,
          force: false,
          dereference: false,
        });
      }
      let installed = await verifyPackageDirectory(target);
      if (
        installed.ok &&
        digest(installed.manifest) !== digest(manifest) &&
        (await managedUpdate(id, source, target, installed, manifest))
      )
        installed = await verifyPackageDirectory(target);
      if (!installed.ok || digest(installed.manifest) !== digest(manifest)) {
        results.push({ id, ok: false, code: "bundled_mod_differs" });
        continue;
      }
      saveOwnership(id, manifest);
      if (preferences[id] === false) {
        results.push({ id, ok: true, enabled: false });
        continue;
      }
      await approvalStore.approve(manifest);
      preference(id, true);
      enable.push(id);
      results.push({ id, ok: true, enabled: true });
    }
    return { enable, results };
  }
  return { prepare, preference };
};
