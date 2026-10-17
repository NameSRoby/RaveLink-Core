const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createWidgetIntakeTokenVault } = require("../src/domains/system/widget-intake-token-vault");

const protect = (plain) => ({ ok: true, encrypted: { ...plain } });
const unprotect = (encrypted) => ({ ok: true, plain: { ...encrypted } });

test("managed widget token persists, rotates with bounded overlap, and revokes backups", (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-widget-token-"));
  const vaultPath = path.join(runtimeDir, "widget.vault.json");
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  let clock = 10_000;
  const tokens = ["a".repeat(43), "b".repeat(43)];
  const create = () =>
    createWidgetIntakeTokenVault({
      vaultPath,
      persistent: true,
      protect,
      unprotect,
      now: () => clock,
      overlapMs: 60_000,
      generateToken: () => tokens.shift() || "c".repeat(43),
    });
  const vault = create();
  const first = vault.rotate();
  assert.equal(first.ok, true);
  assert.equal(first.token, "a".repeat(43));
  assert.equal(JSON.stringify(first.widgetSecurity).includes(first.token), false);
  assert.equal(vault.verify(first.token).matched, "current");

  clock += 1_000;
  const second = vault.rotate();
  assert.equal(vault.verify(first.token).matched, "previous");
  assert.equal(vault.verify(second.token).matched, "current");
  assert.equal(vault.getStatus().overlapActive, true);
  assert.equal(fs.existsSync(`${vaultPath}.bak`), true);

  const restored = create();
  assert.equal(restored.verify(second.token).ok, true);
  assert.equal(restored.getStatus().configured, true);
  clock += 60_001;
  assert.equal(restored.verify(first.token).ok, false);
  assert.equal(restored.getStatus().overlapActive, false);

  assert.equal(restored.clear().ok, true);
  assert.equal(fs.existsSync(vaultPath), false);
  assert.equal(fs.existsSync(`${vaultPath}.bak`), false);
  assert.equal(restored.getStatus().configured, false);
});

test("environment widget token overrides managed storage and is read-only", (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-widget-env-token-"));
  const vaultPath = path.join(runtimeDir, "widget.vault.json");
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  fs.writeFileSync(vaultPath, "not-json", "utf8");
  const vault = createWidgetIntakeTokenVault({
    vaultPath,
    environmentToken: "deployment-token",
    persistent: true,
    protect,
    unprotect,
  });
  assert.equal(vault.getStatus().mode, "environment_read_only");
  assert.equal(vault.getStatus().managementAvailable, false);
  assert.equal(vault.verify("deployment-token").ok, true);
  assert.equal(vault.verify("wrong").ok, false);
  assert.equal(vault.rotate().status, 409);
  assert.equal(vault.clear().status, 409);
  assert.equal(fs.readFileSync(vaultPath, "utf8"), "not-json");
});
