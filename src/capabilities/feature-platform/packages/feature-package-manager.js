// [TITLE] Module: feature-platform/packages/feature-package-manager.js
// [TITLE] Purpose: verified install, update, rollback, and removal of first-party features

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { verifyFeaturePackageDirectory } = require("./feature-package-integrity");
const { downloadRemotePackage, fetchRemoteManifest, validateOfficialSource } = require("./remote-feature-package");

const FEATURE_ID_RE = /^[a-z][a-z0-9-]{1,63}$/;

function inside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function pathExists(target) {
  try { await fs.promises.lstat(target); return true; } catch { return false; }
}

function compareVersions(leftRaw, rightRaw) {
  const parse = raw => {
    const version = String(raw || "").split("+")[0];
    const divider = version.indexOf("-");
    const core = divider < 0 ? version : version.slice(0, divider);
    const suffix = divider < 0 ? "" : version.slice(divider + 1);
    return { core: core.split(".").map(Number), suffix: suffix ? suffix.split(".") : [] };
  };
  const left = parse(leftRaw);
  const right = parse(rightRaw);
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] > right.core[index] ? 1 : -1;
  }
  if (!left.suffix.length && right.suffix.length) return 1;
  if (left.suffix.length && !right.suffix.length) return -1;
  for (let index = 0; index < Math.max(left.suffix.length, right.suffix.length); index += 1) {
    if (left.suffix[index] === undefined) return -1;
    if (right.suffix[index] === undefined) return 1;
    if (left.suffix[index] === right.suffix[index]) continue;
    const leftNumeric = /^\d+$/.test(left.suffix[index]);
    const rightNumeric = /^\d+$/.test(right.suffix[index]);
    if (leftNumeric && rightNumeric) return Number(left.suffix[index]) > Number(right.suffix[index]) ? 1 : -1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left.suffix[index].localeCompare(right.suffix[index]);
  }
  return 0;
}

module.exports = function createFeaturePackageManager(options = {}) {
  const installedRoot = path.resolve(options.installedRoot || path.join(process.cwd(), "features", "installed"));
  const packageRoots = (Array.isArray(options.packageRoots) ? options.packageRoots : [options.packageRoot])
    .filter(Boolean).map(value => path.resolve(value));
  const remoteSources = (Array.isArray(options.remoteSources) ? options.remoteSources : [])
    .map(validateOfficialSource).filter(Boolean);
  const runtimeRoot = path.resolve(options.runtimeRoot || path.join(process.cwd(), "runtime", "features"));
  const rollbackRoot = path.join(installedRoot, ".rollback");
  let mutation = Promise.resolve();

  async function bundledPackages() {
    const packages = new Map();
    for (const root of packageRoots) {
      if (!fs.existsSync(root)) continue;
      const entries = await fs.promises.readdir(root, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === "installed" || entry.name.startsWith(".")) continue;
        const source = path.join(root, entry.name);
        const verified = await verifyFeaturePackageDirectory(source, { limits: options.packageLimits });
        if (!verified.ok || packages.has(verified.manifest.id)) continue;
        packages.set(verified.manifest.id, { source, verified });
      }
    }
    return packages;
  }

  async function availablePackages() {
    const packages = await bundledPackages();
    const warnings = [];
    for (const source of remoteSources) {
      const remote = await fetchRemoteManifest(source, { fetchImpl: options.fetchImpl, timeoutMs: options.remoteTimeoutMs, limits: options.packageLimits });
      if (!remote.ok) {
        warnings.push({ featureId: source.id, source: source.displaySource, error: remote.error });
        continue;
      }
      const current = packages.get(source.id);
      if (!current || compareVersions(remote.manifest.version, current.verified.manifest.version) > 0) {
        packages.set(source.id, {
          kind: "remote",
          source,
          remote,
          verified: { manifest: remote.manifest, totalBytes: 0 }
        });
      }
    }
    return { packages, warnings };
  }

  async function stagePackage(source, staging) {
    if (source.kind === "remote") {
      const downloaded = await downloadRemotePackage(source.source, staging, {
        remote: source.remote,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.remoteTimeoutMs,
        limits: options.packageLimits
      });
      if (!downloaded.ok) throw new Error(downloaded.error || "remote_feature_download_failed");
      return;
    }
    await fs.promises.cp(source.source, staging, { recursive: true, errorOnExist: true, force: false });
  }

  async function listAvailable() {
    const { packages, warnings } = await availablePackages();
    const features = [];
    for (const { verified } of packages.values()) {
      const target = path.join(installedRoot, verified.manifest.id);
      const installed = await pathExists(target);
      const current = installed ? await verifyFeaturePackageDirectory(target, { limits: options.packageLimits }) : null;
      features.push({
        id: verified.manifest.id,
        name: verified.manifest.name,
        version: verified.manifest.version,
        description: verified.manifest.description,
        installed,
        installedVersion: current?.ok ? current.manifest.version : "",
        updateAvailable: Boolean(current?.ok && compareVersions(verified.manifest.version, current.manifest.version) > 0),
        rollbackAvailable: await pathExists(path.join(rollbackRoot, verified.manifest.id)),
        permissions: { ...verified.manifest.permissions },
        resources: { ...verified.manifest.resources },
        bytes: verified.totalBytes,
        source: packages.get(verified.manifest.id)?.kind === "remote" ? "github" : "bundled",
        downloadRequired: packages.get(verified.manifest.id)?.kind === "remote"
      });
    }
    features.sort((a, b) => a.id.localeCompare(b.id));
    return { ok: true, total: features.length, features, warnings };
  }

  function serialize(operation) {
    const next = mutation.then(operation, operation);
    mutation = next.catch(() => undefined);
    return next;
  }

  function hasRollback(featureIdRaw) {
    const featureId = String(featureIdRaw || "");
    if (!FEATURE_ID_RE.test(featureId)) return false;
    const rollbackPath = path.join(rollbackRoot, featureId);
    return inside(installedRoot, rollbackPath) && fs.existsSync(rollbackPath);
  }

  function install(featureIdRaw) {
    return serialize(async () => {
      const featureId = String(featureIdRaw || "");
      if (!FEATURE_ID_RE.test(featureId)) return { ok: false, error: "invalid_feature_id" };
      const { packages } = await availablePackages();
      const source = packages.get(featureId);
      if (!source) return { ok: false, error: "feature_package_not_available" };
      const target = path.join(installedRoot, featureId);
      if (fs.existsSync(target)) return { ok: false, error: "feature_already_installed" };
      await fs.promises.mkdir(installedRoot, { recursive: true });
      const staging = path.join(installedRoot, `.${featureId}.install-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
      if (!inside(installedRoot, staging) || !inside(installedRoot, target)) return { ok: false, error: "feature_install_path_invalid" };
      try {
        await stagePackage(source, staging);
        const verified = await verifyFeaturePackageDirectory(staging, { limits: options.packageLimits });
        if (!verified.ok || verified.manifest.id !== featureId) throw new Error(verified.error || "feature_staging_verification_failed");
        await fs.promises.rename(staging, target);
        return { ok: true, featureId, version: verified.manifest.version, installed: true };
      } catch (error) {
        if (inside(installedRoot, staging)) await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => undefined);
        return { ok: false, error: String(error?.message || "feature_install_failed").slice(0, 160) };
      }
    });
  }

  function update(featureIdRaw) {
    return serialize(async () => {
      const featureId = String(featureIdRaw || "");
      if (!FEATURE_ID_RE.test(featureId)) return { ok: false, error: "invalid_feature_id" };
      const target = path.join(installedRoot, featureId);
      const rollback = path.join(rollbackRoot, featureId);
      if (!inside(installedRoot, target) || !await pathExists(target)) return { ok: false, error: "feature_not_installed" };
      const current = await verifyFeaturePackageDirectory(target, { limits: options.packageLimits });
      if (!current.ok) return { ok: false, error: "installed_feature_invalid", detail: current.error };
      const { packages } = await availablePackages();
      const source = packages.get(featureId);
      if (!source) return { ok: false, error: "feature_package_not_available" };
      if (compareVersions(source.verified.manifest.version, current.manifest.version) <= 0) {
        return { ok: false, error: "feature_update_not_newer", installedVersion: current.manifest.version, availableVersion: source.verified.manifest.version };
      }
      await fs.promises.mkdir(installedRoot, { recursive: true });
      await fs.promises.mkdir(rollbackRoot, { recursive: true });
      const staging = path.join(installedRoot, `.${featureId}.update-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
      let movedCurrent = false;
      try {
        await stagePackage(source, staging);
        const staged = await verifyFeaturePackageDirectory(staging, { limits: options.packageLimits });
        if (!staged.ok || staged.manifest.id !== featureId) throw new Error(staged.error || "feature_staging_verification_failed");
        if (await pathExists(rollback)) await fs.promises.rm(rollback, { recursive: true, force: true });
        await fs.promises.rename(target, rollback);
        movedCurrent = true;
        await fs.promises.rename(staging, target);
        return {
          ok: true,
          operation: "updated",
          featureId,
          version: staged.manifest.version,
          previousVersion: current.manifest.version,
          rollbackAvailable: true
        };
      } catch (error) {
        if (movedCurrent && !await pathExists(target) && await pathExists(rollback)) {
          await fs.promises.rename(rollback, target).catch(() => undefined);
        }
        return { ok: false, error: "feature_update_failed", detail: String(error?.message || error).slice(0, 160) };
      } finally {
        if (inside(installedRoot, staging) && await pathExists(staging)) await fs.promises.rm(staging, { recursive: true, force: true });
      }
    });
  }

  function rollback(featureIdRaw) {
    return serialize(async () => {
      const featureId = String(featureIdRaw || "");
      if (!FEATURE_ID_RE.test(featureId)) return { ok: false, error: "invalid_feature_id" };
      const target = path.join(installedRoot, featureId);
      const rollbackPath = path.join(rollbackRoot, featureId);
      if (!inside(installedRoot, target) || !await pathExists(target)) return { ok: false, error: "feature_not_installed" };
      if (!inside(installedRoot, rollbackPath) || !await pathExists(rollbackPath)) return { ok: false, error: "feature_rollback_unavailable" };
      const current = await verifyFeaturePackageDirectory(target, { limits: options.packageLimits });
      const previous = await verifyFeaturePackageDirectory(rollbackPath, { limits: options.packageLimits });
      if (!current.ok) return { ok: false, error: "installed_feature_invalid", detail: current.error };
      if (!previous.ok || previous.manifest.id !== featureId) return { ok: false, error: "feature_rollback_invalid", detail: previous.error };
      const swap = path.join(installedRoot, `.${featureId}.rollback-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
      try {
        await fs.promises.rename(target, swap);
        try {
          await fs.promises.rename(rollbackPath, target);
          await fs.promises.rename(swap, rollbackPath);
        } catch (error) {
          if (!await pathExists(target) && await pathExists(swap)) await fs.promises.rename(swap, target).catch(() => undefined);
          else if (await pathExists(target) && await pathExists(swap) && !await pathExists(rollbackPath)) {
            await fs.promises.rename(target, rollbackPath).catch(() => undefined);
            await fs.promises.rename(swap, target).catch(() => undefined);
          }
          throw error;
        }
        return {
          ok: true,
          operation: "rolled_back",
          featureId,
          version: previous.manifest.version,
          replacedVersion: current.manifest.version,
          rollbackAvailable: true
        };
      } catch (error) {
        return { ok: false, error: "feature_rollback_failed", detail: String(error?.message || error).slice(0, 160) };
      }
    });
  }

  function uninstall(featureIdRaw, uninstallOptions = {}) {
    return serialize(async () => {
      const featureId = String(featureIdRaw || "");
      if (!FEATURE_ID_RE.test(featureId)) return { ok: false, error: "invalid_feature_id" };
      const target = path.join(installedRoot, featureId);
      if (!inside(installedRoot, target) || !fs.existsSync(target)) return { ok: false, error: "feature_not_installed" };
      const quarantine = path.join(installedRoot, `.${featureId}.remove-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
      if (!inside(installedRoot, quarantine)) return { ok: false, error: "feature_uninstall_path_invalid" };
      try {
        await fs.promises.rename(target, quarantine);
        await fs.promises.rm(quarantine, { recursive: true, force: true });
        const rollbackPath = path.join(rollbackRoot, featureId);
        if (inside(installedRoot, rollbackPath)) await fs.promises.rm(rollbackPath, { recursive: true, force: true });
        let dataDeleted = false;
        const dataPath = path.join(runtimeRoot, "data", featureId);
        if (uninstallOptions.deleteData === true && inside(path.join(runtimeRoot, "data"), dataPath)) {
          await fs.promises.rm(dataPath, { recursive: true, force: true });
          dataDeleted = true;
        }
        return { ok: true, featureId, installed: false, dataDeleted };
      } catch (error) {
        if (!fs.existsSync(target) && fs.existsSync(quarantine)) await fs.promises.rename(quarantine, target).catch(() => undefined);
        return { ok: false, error: String(error?.message || "feature_uninstall_failed").slice(0, 160) };
      }
    });
  }

  return Object.freeze({ hasRollback, install, listAvailable, rollback, uninstall, update });
};

module.exports.compareVersions = compareVersions;
