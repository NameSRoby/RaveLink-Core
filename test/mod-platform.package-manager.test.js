// [TITLE] Test Module: test/mod-platform.package-manager.test.js
// [TITLE] Purpose: verify atomic mod install, approval, update, rollback, and uninstall behavior

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const createModPackageManager = require("../src/capabilities/mod-platform/packages/mod-package-manager");
const createModHostRegistry = require("../src/capabilities/mod-platform/host/mod-host-registry");
const { createPackage } = require("./helpers/mod-package-fixture");

async function fixture(t) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ravelink-package-manager-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const modsRoot = path.join(root, "mods");
  const runtimeRoot = path.join(root, "runtime", "mods");
  return { root, modsRoot, runtimeRoot };
}

test("package manager installs disabled and requires exact approval", async (t) => {
  const paths = await fixture(t);
  const source = path.join(paths.root, "source-v1");
  await createPackage(source);
  const manager = createModPackageManager(paths);
  const inspected = await manager.inspectSource(source);
  assert.equal(inspected.ok, true);
  assert.equal(inspected.approval.needsApproval, true);
  const installed = await manager.install(source);
  assert.equal(installed.operation, "installed");
  assert.equal(installed.enabled, false);
  assert.equal(installed.approval.needsApproval, true);
  assert.equal(
    fs.existsSync(path.join(paths.modsRoot, "example.package-mod", "dist", "main.js")),
    true,
  );

  const mismatch = await manager.approve("example.package-mod", "wrong");
  assert.equal(mismatch.error, "approval_fingerprint_mismatch");
  const approved = await manager.approve("example.package-mod", installed.approval.fingerprint);
  assert.equal(approved.approved, true);
  assert.equal((await manager.getInstalledStatus("example.package-mod")).approval.approved, true);
});

test("package update reports permission/resource diffs and retains rollback", async (t) => {
  const paths = await fixture(t);
  const sourceV1 = path.join(paths.root, "source-v1");
  const sourceV2 = path.join(paths.root, "source-v2");
  await createPackage(sourceV1, { version: "1.0.0" });
  await createPackage(sourceV2, {
    version: "2.0.0",
    source: "module.exports = { version: 2 };\n",
    permissions: { network: ["api.example.com:443"], storage: true },
    resources: { activeRssMiB: 96, externalInFlight: 1 },
  });
  const manager = createModPackageManager(paths);
  const first = await manager.install(sourceV1);
  await manager.approve("example.package-mod", first.approval.fingerprint);
  const updated = await manager.install(sourceV2, { replace: true });
  assert.equal(updated.operation, "updated");
  assert.equal(updated.previousVersionRetained, true);
  assert.equal(updated.approval.needsApproval, true);
  assert.equal(updated.approval.diff.added.includes("permissions.storage"), true);
  assert.equal(
    updated.approval.diff.added.includes("permissions.network:api.example.com:443"),
    true,
  );
  assert.equal(
    updated.approval.diff.increased.some((row) => row.resource === "activeRssMiB"),
    true,
  );
  assert.equal((await manager.getInstalledStatus("example.package-mod")).rollbackAvailable, true);

  const rolledBack = await manager.rollback("example.package-mod");
  assert.equal(rolledBack.operation, "rolled_back");
  assert.equal(rolledBack.version, "1.0.0");
  assert.equal(rolledBack.approval.approved, true);
});

test("package manager refuses replacement or uninstall while a mod is active", async (t) => {
  const paths = await fixture(t);
  const source = path.join(paths.root, "source-v1");
  await createPackage(source);
  let active = false;
  const manager = createModPackageManager({
    ...paths,
    isModActive: () => active,
  });
  await manager.install(source);
  active = true;
  assert.equal((await manager.install(source, { replace: true })).error, "mod_must_be_disabled");
  assert.equal((await manager.uninstall("example.package-mod")).error, "mod_must_be_disabled");
  assert.equal(fs.existsSync(path.join(paths.modsRoot, "example.package-mod")), true);
});

test("uninstall retains data by default and deletes it only explicitly", async (t) => {
  const paths = await fixture(t);
  const source = path.join(paths.root, "source-v1");
  await createPackage(source);
  const manager = createModPackageManager(paths);
  let installed = await manager.install(source);
  await manager.approve("example.package-mod", installed.approval.fingerprint);
  const dataPath = path.join(paths.runtimeRoot, "data", "example.package-mod", "state.json");
  await fs.promises.mkdir(path.dirname(dataPath), { recursive: true });
  await fs.promises.writeFile(dataPath, "{}\n", "utf8");
  let removed = await manager.uninstall("example.package-mod");
  assert.equal(removed.dataRetained, true);
  assert.equal(fs.existsSync(dataPath), true);

  installed = await manager.install(source);
  assert.equal(installed.approval.needsApproval, true, "uninstall must revoke prior approval");
  removed = await manager.uninstall("example.package-mod", {
    deleteData: true,
  });
  assert.equal(removed.dataRetained, false);
  assert.equal(fs.existsSync(path.dirname(dataPath)), false);
});

test("package manager rejects invalid IDs without touching paths", async (t) => {
  const paths = await fixture(t);
  const manager = createModPackageManager(paths);
  assert.equal(
    (await manager.uninstall("../../escape", { deleteData: true })).error,
    "invalid_mod_id",
  );
  assert.equal((await manager.rollback("C:/escape")).error, "invalid_mod_id");
});

test("host rechecks package integrity and exact approval before activation", async (t) => {
  const paths = await fixture(t);
  const source = path.join(paths.root, "source-v1");
  await createPackage(source);
  const manager = createModPackageManager(paths);
  const installed = await manager.install(source);
  const fakeSupervisorFactory = (options) => {
    let lifecycle = "installed-disabled";
    const api = {
      getStatus: () => ({
        ok: true,
        modId: options.manifest.id,
        lifecycle,
        lastError: "",
      }),
      start: async () => {
        lifecycle = "active";
        return api.getStatus();
      },
      stop: async () => {
        lifecycle = "installed-disabled";
        return api.getStatus();
      },
      request: async () => ({ ok: true }),
    };
    return api;
  };
  const registry = createModHostRegistry({
    modsRoot: paths.modsRoot,
    runtimeRoot: paths.runtimeRoot,
    supervisorFactory: fakeSupervisorFactory,
  });
  registry.discover();
  let activation = await registry.enable("example.package-mod");
  assert.equal(activation.error, "permission_approval_required");

  await manager.approve("example.package-mod", installed.approval.fingerprint);
  await fs.promises.writeFile(
    path.join(paths.modsRoot, "example.package-mod", "dist", "main.js"),
    "tampered\n",
    "utf8",
  );
  activation = await registry.enable("example.package-mod");
  assert.equal(activation.error, "package_integrity_invalid");

  const repaired = await manager.install(source, { replace: true });
  assert.equal(repaired.approval.approved, true);
  registry.discover();
  activation = await registry.enable("example.package-mod");
  assert.equal(activation.lifecycle, "active");
  await registry.shutdown();
});
