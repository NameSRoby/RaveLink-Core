// [TITLE] Test Module: test/mod-platform.process-permissions.test.js
// [TITLE] Purpose: verify fail-closed mod process permission launch policy

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildModProcessPermissions,
  detectPermissionSupport,
} = require("../src/capabilities/mod-platform/host/mod-process-permissions");

const manifest = {
  permissions: {
    network: ["api.example.com:443"],
    storage: true,
    process: false,
  },
};

test("permission policy fails closed without enforceable network isolation", () => {
  const result = buildModProcessPermissions({
    manifest,
    modRoot: "C:/mods/example",
    storageRoot: "C:/data/example",
    support: {
      permission: true,
      fsRead: true,
      fsWrite: true,
      network: false,
      childProcess: true,
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "runtime_isolation_unavailable");
  assert.equal(result.missing.includes("network_policy"), true);
});

test("permission policy builds least-privilege flags when all controls exist", () => {
  const result = buildModProcessPermissions({
    manifest,
    modRoot: "C:/mods/example",
    storageRoot: "C:/data/example",
    platformRoot: "C:/app/mod-platform",
    support: {
      permission: true,
      fsRead: true,
      fsWrite: true,
      network: true,
      childProcess: true,
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.unsafe, false);
  assert.equal(result.execArgv.includes("--permission"), true);
  assert.equal(
    result.execArgv.some((flag) => flag.startsWith("--allow-net=")),
    false,
    "network must remain broker-only",
  );
  assert.equal(
    result.execArgv.some((flag) => flag.startsWith("--allow-fs-write=")),
    false,
    "storage must remain broker-only",
  );
  assert.equal(result.execArgv.includes("--allow-child-process"), false);
});

test("unsafe developer override is explicit and reports missing controls", () => {
  const result = buildModProcessPermissions({
    manifest,
    modRoot: "C:/mods/example",
    support: {
      permission: true,
      fsRead: true,
      fsWrite: true,
      network: false,
      childProcess: true,
    },
    allowUnsafeRuntime: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.unsafe, true);
  assert.equal(result.code, "unsafe_developer_override");
});

test("installed Node permission support is detected without assumptions", () => {
  const support = detectPermissionSupport();
  assert.equal(typeof support.permission, "boolean");
  assert.equal(typeof support.network, "boolean");
  assert.equal(Object.isFrozen(support), true);
});

test("the shared flag builder cannot grant native addons to a third-party mod", () => {
  const result = buildModProcessPermissions({
    manifest: { permissions: { nativeAddons: true } },
    support: { permission: true, fsRead: true, network: true, addons: true },
  });
  assert.equal(result.ok, true);
  assert.equal(result.execArgv.includes("--allow-addons"), false);
  assert.equal(
    result.execArgv.some((flag) => flag.startsWith("--allow-fs-read=")),
    true,
  );
});
