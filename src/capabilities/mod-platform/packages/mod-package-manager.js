// [TITLE] Module: capabilities/mod-platform/packages/mod-package-manager.js
// [TITLE] Purpose: atomically install, update, roll back, and uninstall verified mod packages
// [TITLE] Functionality Index:
// [TITLE] - stage and re-verify local directory packages before activation visibility
// [TITLE] - retain one verified rollback version and recover failed atomic switches
// [TITLE] - require exact permission/resource approval and explicit data deletion
// [DEV] Package operations are serialized because filesystem switches and approval
// [DEV] changes are rare control-plane work where determinism matters more than throughput.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const createModApprovalStore = require("./mod-approval-store");
const { extractZipArchive } = require("./mod-package-archive");
const { verifyPackageDirectory, MANIFEST_NAME } = require("./mod-package-integrity");

const MOD_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}\.[a-z0-9][a-z0-9-]{0,31}$/;

async function pathExists(filePath) {
  try { await fs.promises.lstat(filePath); return true; } catch { return false; }
}

async function copyVerifiedTree(sourceRoot, destinationRoot, files) {
  await fs.promises.mkdir(destinationRoot, { recursive: true });
  for (const row of files) {
    const source = path.join(sourceRoot, ...row.path.split("/"));
    const destination = path.join(destinationRoot, ...row.path.split("/"));
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
  }
}

module.exports = function createModPackageManager(options = {}) {
  const modsRoot = path.resolve(String(options.modsRoot || path.join(process.cwd(), "mods")));
  const runtimeRoot = path.resolve(String(options.runtimeRoot || path.join(process.cwd(), "runtime", "mods")));
  const stagingRoot = path.join(runtimeRoot, "staging");
  const rollbackRoot = path.join(runtimeRoot, "rollback");
  const dataRoot = path.join(runtimeRoot, "data");
  const approvalStore = options.approvalStore || createModApprovalStore({
    storePath: path.join(runtimeRoot, "approvals.json"),
    now: options.now
  });
  const isModActive = typeof options.isModActive === "function" ? options.isModActive : (() => false);
  const limits = options.limits || {};
  const archiveLimits = options.archiveLimits || {};
  let operation = Promise.resolve();

  function exclusive(task) {
    const next = operation.then(task, task);
    operation = next.catch(() => {});
    return next;
  }

  function pathsFor(modId) {
    if (!MOD_ID_RE.test(modId)) throw new Error("invalid_mod_id");
    return {
      target: path.join(modsRoot, modId),
      rollback: path.join(rollbackRoot, modId),
      data: path.join(dataRoot, modId)
    };
  }

  async function inspectSource(sourcePath) {
    const verification = await verifyPackageDirectory(sourcePath, { limits });
    if (!verification.ok) return verification;
    const approval = await approvalStore.getStatus(verification.manifest);
    return {
      ok: true,
      manifest: verification.manifest,
      files: verification.files,
      totalBytes: verification.totalBytes,
      approval
    };
  }

  async function installUnlocked(sourcePath, installOptions = {}) {
    const source = await verifyPackageDirectory(sourcePath, { limits });
    if (!source.ok) return source;
    const modId = source.manifest.id;
    const locations = pathsFor(modId);
    if (isModActive(modId)) return { ok: false, error: "mod_must_be_disabled", modId };
    const targetExists = await pathExists(locations.target);
    if (targetExists && installOptions.replace !== true) return { ok: false, error: "mod_already_installed", modId };

    await fs.promises.mkdir(stagingRoot, { recursive: true });
    await fs.promises.mkdir(rollbackRoot, { recursive: true });
    const stage = path.join(stagingRoot, `${modId}-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
    let movedCurrent = false;
    try {
      await copyVerifiedTree(source.root, stage, source.files);
      const staged = await verifyPackageDirectory(stage, { limits });
      if (!staged.ok) return { ...staged, error: `staged_${staged.error}` };
      if (targetExists) {
        if (await pathExists(locations.rollback)) await fs.promises.rm(locations.rollback, { recursive: true, force: true });
        await fs.promises.rename(locations.target, locations.rollback);
        movedCurrent = true;
      } else {
        await fs.promises.mkdir(modsRoot, { recursive: true });
      }
      try {
        await fs.promises.rename(stage, locations.target);
      } catch (error) {
        if (movedCurrent && !(await pathExists(locations.target)) && await pathExists(locations.rollback)) {
          await fs.promises.rename(locations.rollback, locations.target);
        }
        throw error;
      }
      const approval = await approvalStore.getStatus(staged.manifest);
      return {
        ok: true,
        operation: targetExists ? "updated" : "installed",
        modId,
        version: staged.manifest.version,
        previousVersionRetained: movedCurrent,
        enabled: false,
        approval
      };
    } catch (error) {
      return { ok: false, error: "package_install_failed", detail: String(error?.message || error).slice(0, 200), modId };
    } finally {
      if (await pathExists(stage)) await fs.promises.rm(stage, { recursive: true, force: true });
    }
  }

  function install(sourcePath, installOptions) {
    return exclusive(() => installUnlocked(sourcePath, installOptions));
  }

  function installArchive(archivePath, installOptions) {
    return exclusive(async () => {
      await fs.promises.mkdir(stagingRoot, { recursive: true });
      const extracted = path.join(stagingRoot, `archive-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
      try {
        const result = await extractZipArchive(archivePath, extracted, { limits: archiveLimits });
        if (!result.ok) return result;
        return await installUnlocked(extracted, installOptions);
      } finally {
        if (await pathExists(extracted)) await fs.promises.rm(extracted, { recursive: true, force: true });
      }
    });
  }

  function inspectArchive(archivePath) {
    return exclusive(async () => {
      await fs.promises.mkdir(stagingRoot, { recursive: true });
      const extracted = path.join(stagingRoot, `inspect-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
      try {
        const result = await extractZipArchive(archivePath, extracted, { limits: archiveLimits });
        if (!result.ok) return result;
        return await inspectSource(extracted);
      } finally {
        if (await pathExists(extracted)) await fs.promises.rm(extracted, { recursive: true, force: true });
      }
    });
  }

  async function approve(modId, expectedFingerprint) {
    return exclusive(async () => {
      let locations;
      try { locations = pathsFor(modId); } catch { return { ok: false, error: "invalid_mod_id" }; }
      const installed = await verifyPackageDirectory(locations.target, { limits });
      if (!installed.ok) return { ok: false, error: "installed_package_invalid", detail: installed.error, modId };
      return await approvalStore.approve(installed.manifest, expectedFingerprint);
    });
  }

  async function getInstalledStatus(modId) {
    let locations;
    try { locations = pathsFor(modId); } catch { return { ok: false, error: "invalid_mod_id" }; }
    const installed = await verifyPackageDirectory(locations.target, { limits });
    if (!installed.ok) return { ok: false, error: "installed_package_invalid", detail: installed.error, modId };
    return {
      ok: true,
      modId,
      version: installed.manifest.version,
      approval: await approvalStore.getStatus(installed.manifest),
      rollbackAvailable: await pathExists(locations.rollback),
      dataPresent: await pathExists(locations.data)
    };
  }

  function rollback(modId) {
    return exclusive(async () => {
      let locations;
      try { locations = pathsFor(modId); } catch { return { ok: false, error: "invalid_mod_id" }; }
      if (isModActive(modId)) return { ok: false, error: "mod_must_be_disabled", modId };
      if (!(await pathExists(locations.rollback))) return { ok: false, error: "rollback_unavailable", modId };
      const rollbackPackage = await verifyPackageDirectory(locations.rollback, { limits });
      if (!rollbackPackage.ok) return { ok: false, error: "rollback_package_invalid", detail: rollbackPackage.error, modId };
      const swap = path.join(stagingRoot, `${modId}-rollback-${crypto.randomBytes(6).toString("hex")}`);
      await fs.promises.mkdir(stagingRoot, { recursive: true });
      try {
        await fs.promises.rename(locations.target, swap);
        await fs.promises.rename(locations.rollback, locations.target);
        await fs.promises.rename(swap, locations.rollback);
      } catch (error) {
        if (!(await pathExists(locations.target)) && await pathExists(swap)) await fs.promises.rename(swap, locations.target);
        return { ok: false, error: "rollback_switch_failed", detail: String(error?.message || error).slice(0, 200), modId };
      }
      return {
        ok: true,
        operation: "rolled_back",
        modId,
        version: rollbackPackage.manifest.version,
        enabled: false,
        approval: await approvalStore.getStatus(rollbackPackage.manifest)
      };
    });
  }

  function uninstall(modId, uninstallOptions = {}) {
    return exclusive(async () => {
      let locations;
      try { locations = pathsFor(modId); } catch { return { ok: false, error: "invalid_mod_id" }; }
      if (isModActive(modId)) return { ok: false, error: "mod_must_be_disabled", modId };
      const installed = await pathExists(locations.target);
      if (installed) await fs.promises.rm(locations.target, { recursive: true, force: true });
      if (await pathExists(locations.rollback)) await fs.promises.rm(locations.rollback, { recursive: true, force: true });
      const deleteData = uninstallOptions.deleteData === true;
      if (deleteData && await pathExists(locations.data)) await fs.promises.rm(locations.data, { recursive: true, force: true });
      await approvalStore.revoke(modId);
      return {
        ok: true,
        operation: "uninstalled",
        modId,
        removed: installed,
        dataRetained: !deleteData && await pathExists(locations.data)
      };
    });
  }

  return Object.freeze({ approve, getInstalledStatus, inspectArchive, inspectSource, install, installArchive, rollback, uninstall });
};

module.exports.copyVerifiedTree = copyVerifiedTree;
module.exports.pathExists = pathExists;
