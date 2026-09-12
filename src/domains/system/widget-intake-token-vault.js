// [TITLE] Module: domains/system/widget-intake-token-vault.js
// [TITLE] Purpose: hybrid environment/DPAPI token ownership for hosted widget intake

const crypto = require("node:crypto");
const fs = require("node:fs");
const { readJsonFileWithMetadata, writeJsonFile } = require("../../shared/fs/json-file-store");
const { protectTextMapWithWindowsDpapi, unprotectTextMapWithWindowsDpapi } = require("../../shared/security/windows-dpapi");
const { timingSafeTokenEqual } = require("./widget-intake-token");

const VAULT_VERSION = 1;

function asString(value) { return String(value ?? "").trim(); }
function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function removeVaultFiles(vaultPath) {
  try {
    fs.rmSync(vaultPath, { force: true });
    fs.rmSync(`${vaultPath}.bak`, { force: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: asString(error?.message || "widget_token_vault_clear_failed") };
  }
}

function createWidgetIntakeTokenVault(options = {}) {
  const vaultPath = asString(options.vaultPath);
  if (!vaultPath) throw new Error("createWidgetIntakeTokenVault requires vaultPath");
  const environmentToken = asString(options.environmentToken);
  const now = typeof options.now === "function" ? options.now : Date.now;
  const generateToken = typeof options.generateToken === "function"
    ? options.generateToken
    : () => crypto.randomBytes(32).toString("base64url");
  const protect = options.protect || protectTextMapWithWindowsDpapi;
  const unprotect = options.unprotect || unprotectTextMapWithWindowsDpapi;
  const overlapMs = clamp(options.overlapMs, 60_000, 3_600_000, 600_000);
  const persistent = options.persistent ?? process.platform === "win32";
  let state = { current: "", previous: "", previousExpiresAt: 0, updatedAt: 0 };
  let runtime = { loaded: true, recovered: false, lastError: "", lastPersistAt: 0 };

  if (!environmentToken && persistent && (fs.existsSync(vaultPath) || fs.existsSync(`${vaultPath}.bak`))) {
    const loaded = readJsonFileWithMetadata(vaultPath, null);
    const source = loaded.value && typeof loaded.value === "object" ? loaded.value : null;
    if (source?.version === VAULT_VERSION && source.provider === "windows_dpapi") {
      const decoded = unprotect(source.encrypted || {});
      if (decoded.ok) {
        state = {
          current: asString(decoded.plain?.current),
          previous: asString(decoded.plain?.previous),
          previousExpiresAt: Math.max(0, Number(source.previousExpiresAt || 0)),
          updatedAt: Math.max(0, Number(source.updatedAt || 0))
        };
        runtime.recovered = loaded.recovered === true;
      } else {
        runtime.loaded = false;
        runtime.lastError = asString(decoded.error || "widget_token_vault_decrypt_failed");
      }
    } else {
      runtime.loaded = false;
      runtime.lastError = "widget_token_vault_invalid";
    }
  }

  function persist(next) {
    if (!persistent) return { ok: true, provider: "volatile_only" };
    const encoded = protect({ current: next.current, previous: next.previous });
    if (!encoded.ok) return { ok: false, error: asString(encoded.error || "widget_token_vault_encrypt_failed") };
    try {
      writeJsonFile(vaultPath, {
        version: VAULT_VERSION,
        provider: "windows_dpapi",
        previousExpiresAt: next.previousExpiresAt,
        updatedAt: next.updatedAt,
        encrypted: encoded.encrypted || {}
      }, { mode: 0o600 });
      runtime.lastPersistAt = next.updatedAt;
      runtime.lastError = "";
      return { ok: true, provider: "windows_dpapi" };
    } catch (error) {
      runtime.lastError = asString(error?.message || "widget_token_vault_write_failed");
      return { ok: false, error: runtime.lastError };
    }
  }

  function activeState() {
    if (environmentToken) return { current: environmentToken, previous: "", previousExpiresAt: 0, updatedAt: 0 };
    if (state.previous && state.previousExpiresAt <= now()) {
      state = { ...state, previous: "", previousExpiresAt: 0 };
    }
    return state;
  }

  function getStatus() {
    const snapshot = activeState();
    const managed = !environmentToken;
    return {
      ok: true,
      capability: "widget.eventIntake",
      mode: environmentToken ? "environment_read_only" : (persistent ? "managed_windows_dpapi" : "managed_volatile_non_windows"),
      configured: Boolean(snapshot.current),
      managementAvailable: managed,
      overlapActive: Boolean(snapshot.previous && snapshot.previousExpiresAt > now()),
      previousValidUntil: snapshot.previous ? snapshot.previousExpiresAt : 0,
      updatedAt: snapshot.updatedAt,
      vault: {
        enabled: managed && persistent,
        loaded: runtime.loaded,
        recovered: runtime.recovered,
        hasError: Boolean(runtime.lastError),
        lastError: runtime.lastError,
        lastPersistAt: runtime.lastPersistAt
      }
    };
  }

  function verify(candidate) {
    const received = asString(candidate);
    const snapshot = activeState();
    if (!snapshot.current) return { ok: true, required: false, matched: "unscoped" };
    if (timingSafeTokenEqual(received, snapshot.current)) return { ok: true, required: true, matched: "current" };
    if (snapshot.previous && snapshot.previousExpiresAt > now() && timingSafeTokenEqual(received, snapshot.previous)) {
      return { ok: true, required: true, matched: "previous" };
    }
    return { ok: false, required: true, matched: "" };
  }

  function rotate() {
    if (environmentToken) return { ok: false, status: 409, error: "widget_token_environment_managed" };
    const timestamp = Math.max(1, Number(now() || Date.now()));
    const token = asString(generateToken());
    if (token.length < 32) return { ok: false, status: 500, error: "widget_token_generation_failed" };
    const next = {
      current: token,
      previous: state.current,
      previousExpiresAt: state.current ? timestamp + overlapMs : 0,
      updatedAt: timestamp
    };
    const stored = persist(next);
    if (!stored.ok) return { ok: false, status: 500, error: "widget_token_persist_failed" };
    state = next;
    return { ok: true, token, oneTimeReveal: true, widgetSecurity: getStatus() };
  }

  function clear() {
    if (environmentToken) return { ok: false, status: 409, error: "widget_token_environment_managed" };
    const removed = removeVaultFiles(vaultPath);
    if (!removed.ok) return { ok: false, status: 500, error: "widget_token_clear_failed" };
    state = { current: "", previous: "", previousExpiresAt: 0, updatedAt: Math.max(1, Number(now() || Date.now())) };
    runtime.lastError = "";
    runtime.lastPersistAt = state.updatedAt;
    return { ok: true, widgetSecurity: getStatus() };
  }

  return Object.freeze({ getStatus, verify, rotate, clear });
}

module.exports = { createWidgetIntakeTokenVault, removeVaultFiles };
