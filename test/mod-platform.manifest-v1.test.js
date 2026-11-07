// [TITLE] Test Module: test/mod-platform.manifest-v1.test.js
// [TITLE] Purpose: verify strict, least-privilege third-party mod manifest contracts

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isCompatibleModApiRange,
  isSafePackagePath,
  validateManifestV1,
} = require("../src/capabilities/mod-platform/contracts/mod-manifest-v1");

const HASH = "a".repeat(64);

function validManifest(overrides = {}) {
  const base = {
    schemaVersion: 1,
    id: "ravelink.hello-mod",
    name: "Hello Mod",
    description: "A contract fixture.",
    version: "1.2.3",
    publisher: "ravelink",
    license: "MIT",
    entry: "dist/main.js",
    engine: { ravelinkModApi: "^1.0.0", node: ">=22" },
    activationEvents: ["onCapability:song.queue.v1"],
    consumes: ["chat.send.v1?"],
    provides: ["song.queue.v1"],
    permissions: {
      network: ["api.example.com:443"],
      storage: true,
      secrets: ["provider.oauth"],
      ui: true,
      process: false,
      hardware: [],
    },
    resources: {
      idleCpuPercent: 0.1,
      idleRssMiB: 32,
      activeRssMiB: 96,
      timers: 2,
      minTimerMs: 1000,
      ipcFrameBytes: 32768,
      inFlightCalls: 2,
      queuedCalls: 16,
      externalInFlight: 1,
      storageBytes: 1048576,
      historyEntries: 100,
      shutdownGraceMs: 2000,
    },
    integrity: { algorithm: "sha256", files: { "dist/main.js": HASH } },
  };
  return { ...base, ...overrides };
}

function errorCodes(result) {
  return result.errors.map((error) => error.code);
}

test("manifest v1 accepts and freezes a bounded opt-in manifest", () => {
  const result = validateManifestV1(validManifest());
  assert.equal(result.ok, true);
  assert.equal(result.value.id, "ravelink.hello-mod");
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value.permissions.network), true);
  assert.equal(Object.isFrozen(result.value.resources), true);
});

test("manifest v1 accepts only integrity-listed UI panels with explicit permission", () => {
  const manifest = validManifest({
    contributes: {
      panels: [{ id: "settings", title: "Settings", entry: "ui/settings.html" }],
    },
    integrity: {
      algorithm: "sha256",
      files: { "dist/main.js": HASH, "ui/settings.html": HASH },
    },
  });
  const accepted = validateManifestV1(manifest);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.value.contributes.panels[0].id, "settings");
  assert.equal(Object.isFrozen(accepted.value.contributes.panels), true);

  manifest.permissions = { ...manifest.permissions, ui: false };
  assert.equal(errorCodes(validateManifestV1(manifest)).includes("ui_permission_required"), true);
  manifest.permissions.ui = true;
  manifest.integrity = { algorithm: "sha256", files: { "dist/main.js": HASH } };
  assert.equal(errorCodes(validateManifestV1(manifest)).includes("panel_not_hashed"), true);
});

test("manifest v1 rejects unknown fields and publisher mismatch", () => {
  const result = validateManifestV1(
    validManifest({
      id: "someone.hello-mod",
      surprise: true,
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(errorCodes(result).includes("unknown_field"), true);
  assert.equal(errorCodes(result).includes("publisher_mismatch"), true);
});

test("manifest v1 rejects traversal, absolute, and unhashed entries", () => {
  for (const entry of ["../escape.js", "C:/escape.js", "dist\\main.js", "/tmp/main.js"]) {
    const result = validateManifestV1(validManifest({ entry }));
    assert.equal(result.ok, false, entry);
    assert.equal(errorCodes(result).includes("unsafe_entry"), true, entry);
  }
  const unhashed = validateManifestV1(validManifest({ entry: "dist/other.js" }));
  assert.equal(errorCodes(unhashed).includes("entry_not_hashed"), true);
});

test("manifest v1 rejects broad or local network permissions", () => {
  for (const host of [
    "*.example.com",
    "localhost",
    "device.local",
    "127.0.0.1",
    "https://api.example.com",
    "api.example.com:70000",
  ]) {
    const manifest = validManifest();
    manifest.permissions = { ...manifest.permissions, network: [host] };
    const result = validateManifestV1(manifest);
    assert.equal(result.ok, false, host);
    assert.equal(
      errorCodes(result).some(
        (code) => code === "invalid_network_host" || code === "invalid_network_port",
      ),
      true,
      host,
    );
  }
});

test("manifest v1 rejects wildcard startup and malformed capability activation", () => {
  for (const activationEvents of [
    ["*"],
    ["onStartup"],
    ["onCapability:song.queue"],
    ["onEvent:Bad Token"],
  ]) {
    const result = validateManifestV1(validManifest({ activationEvents }));
    assert.equal(errorCodes(result).includes("invalid_activation_event"), true);
  }
});

test("manifest v1 rejects duplicate required/optional capability declarations", () => {
  const result = validateManifestV1(validManifest({ consumes: ["chat.send.v1", "chat.send.v1?"] }));
  assert.equal(result.ok, false);
  assert.equal(errorCodes(result).includes("duplicate_item"), true);
});

test("manifest v1 enforces hard resource ceilings and resource ordering", () => {
  const tooLarge = validManifest();
  tooLarge.resources = { ...tooLarge.resources, idleCpuPercent: 1, timers: 9 };
  let result = validateManifestV1(tooLarge);
  assert.equal(result.ok, false);
  assert.equal(errorCodes(result).filter((code) => code === "resource_limit").length, 2);

  const reversed = validManifest();
  reversed.resources = {
    ...reversed.resources,
    idleRssMiB: 64,
    activeRssMiB: 32,
  };
  result = validateManifestV1(reversed);
  assert.equal(errorCodes(result).includes("resource_order"), true);
});

test("manifest v1 accepts only API ranges containing the host major", () => {
  for (const range of ["1.0.0", "^1.0.0", "~1.2.0", "1.x", ">=1.0.0 <2.0.0"]) {
    assert.equal(isCompatibleModApiRange(range, 1), true, range);
  }
  for (const range of ["*", "^2.0.0", ">=0.0.0", "latest", ">=1.0.0 <3.0.0"]) {
    assert.equal(isCompatibleModApiRange(range, 1), false, range);
  }
});

test("safe package paths use exact normalized relative paths", () => {
  assert.equal(isSafePackagePath("dist/main.js"), true);
  assert.equal(isSafePackagePath("dist/./main.js"), false);
  assert.equal(isSafePackagePath("dist/../main.js"), false);
  assert.equal(isSafePackagePath("..evil/main.js"), true);
});
