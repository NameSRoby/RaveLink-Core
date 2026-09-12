// [TITLE] Module: domains/fixtures/fixture-secret-vault.js
// [TITLE] Purpose: user-scoped encrypted storage for fixture routing and Hue credentials

const fs = require("node:fs");
const { readJsonFileWithMetadata, writeJsonFile } = require("../../shared/fs/json-file-store");
const { protectTextMapWithWindowsDpapi, unprotectTextMapWithWindowsDpapi } = require("../../shared/security/windows-dpapi");
const MAX_VAULT_PLAINTEXT_BYTES = 512 * 1024;

function clone(value, fallback = {}) {
  try { return JSON.parse(JSON.stringify(value)); } catch { return fallback; }
}

module.exports = function createFixtureSecretVault(options = {}) {
  const vaultPath = String(options.vaultPath || "").trim();
  const protect = typeof options.protect === "function" ? options.protect : protectTextMapWithWindowsDpapi;
  const unprotect = typeof options.unprotect === "function" ? options.unprotect : unprotectTextMapWithWindowsDpapi;
  if (!vaultPath) throw new Error("createFixtureSecretVault requires vaultPath");
  let secrets = {};
  let status = { provider: process.platform === "win32" || options.protect ? "windows_dpapi" : "volatile_only", persistent: process.platform === "win32" || Boolean(options.protect), loaded: false, error: "" };

  if (fs.existsSync(vaultPath) || fs.existsSync(`${vaultPath}.bak`)) {
    const loaded = readJsonFileWithMetadata(vaultPath, null);
    const decoded = loaded.value?.encrypted ? unprotect(loaded.value.encrypted) : { ok: false, error: "fixture_vault_invalid" };
    if (decoded.ok) {
      try {
        secrets = JSON.parse(String(decoded.plain?.fixtures || "{}"));
        status = { ...status, loaded: true, recovered: loaded.recovered === true };
      } catch { status.error = "fixture_vault_payload_invalid"; }
    } else {
      status.error = String(decoded.error || "fixture_vault_decrypt_failed");
    }
  } else {
    status.loaded = true;
  }

  function getAll() {
    return clone(secrets, {});
  }

  function replaceAll(input = {}) {
    const next = clone(input && typeof input === "object" && !Array.isArray(input) ? input : {}, {});
    const serialized = JSON.stringify(next);
    if (Buffer.byteLength(serialized, "utf8") > MAX_VAULT_PLAINTEXT_BYTES) return { ok: false, error: "fixture_vault_size_limit" };
    if (process.platform !== "win32" && options.allowPortablePersistence !== true && !options.protect) {
      secrets = next;
      status = { ...status, provider: "volatile_only", persistent: false, loaded: true, error: "" };
      return { ok: true, volatileOnly: true };
    }
    const encoded = protect({ fixtures: serialized });
    if (!encoded.ok) return { ok: false, error: String(encoded.error || "fixture_vault_encrypt_failed") };
    try {
      writeJsonFile(vaultPath, { version: 1, provider: "windows_dpapi", encrypted: encoded.encrypted || {} }, { mode: 0o600 });
      secrets = next;
      status = { ...status, provider: "windows_dpapi", persistent: true, loaded: true, error: "" };
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error?.message || "fixture_vault_write_failed") };
    }
  }

  function clear() {
    secrets = {};
    try {
      fs.rmSync(vaultPath, { force: true });
      fs.rmSync(`${vaultPath}.bak`, { force: true });
      return { ok: true };
    } catch (error) { return { ok: false, error: String(error?.message || "fixture_vault_clear_failed") }; }
  }

  function getStatus() {
    return { ...status, fixtureCount: Object.keys(secrets).length };
  }

  return Object.freeze({ getAll, replaceAll, clear, getStatus });
};
