const fs = require("node:fs");
const { readJsonFileWithMetadata, writeJsonFile } = require("../../../shared/fs/json-file-store");
const { protectTextMapWithWindowsDpapi, unprotectTextMapWithWindowsDpapi } = require("../../../shared/security/windows-dpapi");
const { DEFAULT_SCOPES, normalizeScopes, createTwitchApiClient } = require("./twitch-api-client");
const createTwitchEventSubMonitor = require("./twitch-eventsub-monitor");

function text(value, maximum = 2048) { return String(value ?? "").trim().slice(0, maximum); }
const REWARD_PURPOSES = new Set(["lights", "teach", "song_request"]);
const DEFAULT_MONITOR_CONFIG = Object.freeze({ intakeMode: "native", songRequestChatEnabled: false });
const TOKEN_VALIDATE_INTERVAL_MS = 60 * 60 * 1000;
const VALIDATION_RETRY_MS = 60 * 1000;
const ROLE_DIRECTORY_TTL_MS = 30 * 60 * 1000;
const ROLE_DIRECTORY_RETRY_MS = 60 * 1000;

function normalizeManagedRewards(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const result = {};
  for (const purpose of REWARD_PURPOSES) {
    const row = source[purpose];
    const rewardId = text(row?.rewardId, 160);
    if (!rewardId) continue;
    result[purpose] = { purpose, rewardId, title: text(row?.title, 45), cost: Math.max(1, Math.trunc(Number(row?.cost || 1))) };
  }
  return result;
}

module.exports = function createTwitchOAuthProvider(options = {}) {
  const vaultPath = text(options.vaultPath, 1024);
  const defaultClientId = /^[a-z0-9]{10,80}$/i.test(text(options.defaultClientId, 80))
    ? text(options.defaultClientId, 80)
    : "";
  const now = options.now || Date.now;
  const api = options.api || createTwitchApiClient(options);
  const onIntakeModeChange = typeof options.onIntakeModeChange === "function" ? options.onIntakeModeChange : () => {};
  let profile = { clientId: defaultClientId, accessToken: "", refreshToken: "", userId: "", login: "", scopes: [], expiresAt: 0, managedRewards: {}, monitorConfig: { ...DEFAULT_MONITOR_CONFIG } };
  let session = null;
  let lastError = "";
  let refreshInFlight = null;
  let validationInFlight = null;
  let validationAfter = 0;
  let validatedSinceLoad = false;
  let rewardReconcileInFlight = null;
  let rewardReconcileAfter = 0;
  let monitor;
  let roleDirectory = new Map();
  let roleDirectoryAfter = 0;
  let roleDirectoryInFlight = null;
  let roleDirectoryUpdatedAt = 0;
  let roleDirectoryLastError = "";
  const monitorAvailable = typeof api.createEventSubSubscription === "function";

  function normalizeMonitorConfig(input) {
    const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    const legacyEnabled = Object.prototype.hasOwnProperty.call(source, "enabled") ? source.enabled !== false : null;
    const intakeMode = ["native", "streamelements"].includes(source.intakeMode)
      ? source.intakeMode
      : legacyEnabled === false
        ? "streamelements"
        : DEFAULT_MONITOR_CONFIG.intakeMode;
    return { intakeMode, songRequestChatEnabled: intakeMode === "native" && source.songRequestChatEnabled === true };
  }

  function publishIntakeMode() {
    try { onIntakeModeChange(profile.monitorConfig.intakeMode); } catch {}
  }

  function load() {
    if (!vaultPath || (!fs.existsSync(vaultPath) && !fs.existsSync(`${vaultPath}.bak`))) {
      publishIntakeMode();
      return;
    }
    try {
      const raw = readJsonFileWithMetadata(vaultPath, null).value;
      if (!raw || raw.provider !== "windows_dpapi") throw new Error("twitch_vault_invalid");
      const decoded = unprotectTextMapWithWindowsDpapi(raw.encrypted || {});
      if (!decoded.ok) throw new Error(decoded.error || "twitch_vault_decrypt_failed");
      profile = {
        clientId: text(decoded.plain.clientId, 80), accessToken: text(decoded.plain.accessToken), refreshToken: text(decoded.plain.refreshToken),
        userId: text(decoded.plain.userId, 80), login: text(decoded.plain.login, 80),
        scopes: normalizeScopes(JSON.parse(decoded.plain.scopes || "[]"), []), expiresAt: Math.max(0, Number(decoded.plain.expiresAt || 0)),
        managedRewards: normalizeManagedRewards(JSON.parse(decoded.plain.managedRewards || "{}")),
        monitorConfig: normalizeMonitorConfig(JSON.parse(decoded.plain.monitorConfig || "{}"))
      };
    } catch (error) { lastError = text(error?.message || "twitch_vault_load_failed", 120); }
    publishIntakeMode();
  }

  function persist() {
    if (!vaultPath) return false;
    if (process.platform !== "win32") return true;
    const encoded = protectTextMapWithWindowsDpapi({
      clientId: profile.clientId, accessToken: profile.accessToken, refreshToken: profile.refreshToken,
      userId: profile.userId, login: profile.login, scopes: JSON.stringify(profile.scopes), expiresAt: String(profile.expiresAt),
      managedRewards: JSON.stringify(profile.managedRewards || {}), monitorConfig: JSON.stringify(profile.monitorConfig || DEFAULT_MONITOR_CONFIG)
    });
    if (!encoded.ok) { lastError = text(encoded.error || "twitch_vault_encrypt_failed", 120); return false; }
    writeJsonFile(vaultPath, { version: 1, provider: "windows_dpapi", updatedAt: now(), encrypted: encoded.encrypted }, { mode: 0o600 });
    return true;
  }

  function status() {
    const connected = Boolean(profile.accessToken && profile.refreshToken && profile.userId && profile.expiresAt > now());
    return {
      ok: true, configured: Boolean(profile.clientId), connected,
      authorizationStored: Boolean(profile.clientId && profile.refreshToken && profile.userId),
      authorizationRefreshing: Boolean(refreshInFlight), authorizationValidating: Boolean(validationInFlight), rewardSyncing: Boolean(rewardReconcileInFlight),
      login: profile.login, userId: profile.userId, scopes: [...profile.scopes], expiresAt: profile.expiresAt,
      authorizationPending: Boolean(session), userCode: session?.userCode || "", verificationUri: session?.verificationUri || "",
      nextPollAt: session?.nextPollAt || 0, authorizationExpiresAt: session?.expiresAt || 0,
      requiredScopes: [...DEFAULT_SCOPES], missingScopes: DEFAULT_SCOPES.filter(scope => !profile.scopes.includes(scope)),
      managedRewards: Object.values(profile.managedRewards || {}).map(row => ({ ...row })),
      monitorConfig: { ...profile.monitorConfig, enabled: profile.monitorConfig.intakeMode === "native" }, eventSub: monitor?.status?.() || { enabled: false, lifecycle: "stopped", connected: false, subscriptions: [], lastError: "", lastMessageAt: 0, counters: {} },
      roleDirectory: {
        moderators: [...roleDirectory.values()].filter(role => role === "moderator").length,
        vips: [...roleDirectory.values()].filter(role => role === "vip").length,
        refreshing: Boolean(roleDirectoryInFlight), refreshAfter: roleDirectoryAfter,
        updatedAt: roleDirectoryUpdatedAt, lastError: roleDirectoryLastError
      },
      vault: process.platform === "win32" ? "windows_dpapi" : "volatile_only", lastError
    };
  }

  async function configure(input = {}) {
    const clientId = text(input.clientId, 80);
    if (!/^[a-z0-9]{10,80}$/i.test(clientId)) return { ...status(), ok: false, error: "twitch_client_id_invalid" };
    if (clientId !== profile.clientId) {
      monitor?.stop?.();
      profile = { clientId, accessToken: "", refreshToken: "", userId: "", login: "", scopes: [], expiresAt: 0, managedRewards: {}, monitorConfig: { ...DEFAULT_MONITOR_CONFIG } };
      roleDirectory = new Map();
      roleDirectoryAfter = 0;
      roleDirectoryUpdatedAt = 0;
      roleDirectoryLastError = "";
      publishIntakeMode();
    }
    session = null;
    persist();
    return status();
  }

  async function clearClientId() {
    const revoked = await api.revokeToken?.({ clientId: profile.clientId, accessToken: profile.accessToken });
    monitor?.stop?.();
    profile = { clientId: "", accessToken: "", refreshToken: "", userId: "", login: "", scopes: [], expiresAt: 0, managedRewards: {}, monitorConfig: { ...DEFAULT_MONITOR_CONFIG } };
    roleDirectory = new Map();
    roleDirectoryAfter = 0;
    roleDirectoryUpdatedAt = 0;
    roleDirectoryLastError = "";
    publishIntakeMode();
    session = null;
    lastError = revoked?.ok === false ? text(revoked.error || "twitch_revoke_failed", 120) : "";
    persist();
    syncMonitor();
    return status();
  }

  async function begin(input = {}) {
    const request = input && typeof input === "object" ? input : {};
    if (!profile.clientId) return { ...status(), ok: false, error: "twitch_client_id_required" };
    const result = await api.beginDeviceAuthorization({ clientId: profile.clientId, scopes: request.scopes });
    if (!result.ok) { lastError = result.error; return { ...status(), ok: false, error: result.error }; }
    const timestamp = now();
    session = { ...result, expiresAt: timestamp + result.expiresIn * 1000, nextPollAt: timestamp + result.interval * 1000 };
    lastError = "";
    return status();
  }

  async function poll() {
    if (!session || session.expiresAt <= now()) { session = null; return { ...status(), ok: false, error: "twitch_device_session_expired" }; }
    if (session.nextPollAt > now()) return { ...status(), ok: false, error: "twitch_poll_too_fast" };
    session.nextPollAt = now() + session.interval * 1000;
    const result = await api.pollDeviceAuthorization({ clientId: profile.clientId, deviceCode: session.deviceCode, scopes: session.scopes });
    if (!result.ok) { lastError = result.error; return { ...status(), ok: false, error: result.error }; }
    if (result.pending) return status();
    const validated = await api.validateToken(result.accessToken);
    if (!validated.ok || validated.clientId !== profile.clientId) { lastError = validated.error || "twitch_token_client_mismatch"; return { ...status(), ok: false, error: lastError }; }
    profile = {
      clientId: profile.clientId, accessToken: result.accessToken, refreshToken: result.refreshToken,
      userId: validated.userId, login: validated.login, scopes: validated.scopes,
      expiresAt: now() + Math.max(0, validated.expiresIn || result.expiresIn) * 1000,
      managedRewards: profile.managedRewards || {}, monitorConfig: profile.monitorConfig || { ...DEFAULT_MONITOR_CONFIG }
    };
    session = null;
    validatedSinceLoad = true;
    validationAfter = now() + TOKEN_VALIDATE_INTERVAL_MS;
    lastError = "";
    persist();
    syncMonitor();
    void refreshRoleDirectory(true);
    return status();
  }

  async function disconnect() {
    const revoked = await api.revokeToken?.({ clientId: profile.clientId, accessToken: profile.accessToken });
    profile = { ...profile, accessToken: "", refreshToken: "", userId: "", login: "", scopes: [], expiresAt: 0 };
    roleDirectory = new Map();
    roleDirectoryAfter = 0;
    roleDirectoryUpdatedAt = 0;
    roleDirectoryLastError = "";
    session = null;
    monitor?.stop?.();
    lastError = revoked?.ok === false ? text(revoked.error || "twitch_revoke_failed", 120) : "";
    persist();
    return status();
  }

  function credentials() { return { ...profile, scopes: [...profile.scopes] }; }

  async function refreshAuthorization() {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      if (!profile.clientId || !profile.refreshToken || !profile.userId) return { ok: false, error: "twitch_reauthorization_required", retryable: false };
      const previousUserId = profile.userId;
      const refreshed = await api.refreshUserAccessToken({ clientId: profile.clientId, refreshToken: profile.refreshToken });
      if (!refreshed.ok) {
        lastError = text(refreshed.error || "twitch_reauthorization_required", 120);
        const definitive = refreshed.error === "twitch_reauthorization_required" && [400, 401].includes(Number(refreshed.status || 0));
        profile = { ...profile, accessToken: "", expiresAt: 0, ...(definitive ? { refreshToken: "" } : {}) };
        if (definitive) persist();
        return { ok: false, error: lastError, status: refreshed.status || 0, retryable: !definitive };
      }
      // Device-flow refresh tokens rotate on use. Save the replacement before any
      // later network operation so a validation outage cannot strand the grant.
      profile = {
        ...profile,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: now() + Math.max(1, refreshed.expiresIn) * 1000
      };
      persist();
      const validated = await api.validateToken(refreshed.accessToken);
      if (!validated.ok || validated.clientId !== profile.clientId || validated.userId !== previousUserId) {
        lastError = text(validated.error || "twitch_token_identity_mismatch", 120);
        const definitive = validated.error === "twitch_token_invalid" || (validated.ok && (validated.clientId !== profile.clientId || validated.userId !== previousUserId));
        profile = { ...profile, accessToken: "", expiresAt: 0, ...(definitive ? { refreshToken: "" } : {}) };
        if (definitive) persist();
        return { ok: false, error: lastError, retryable: !definitive };
      }
      profile = {
        ...profile,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        login: validated.login,
        scopes: validated.scopes,
        expiresAt: now() + Math.max(1, validated.expiresIn || refreshed.expiresIn) * 1000
      };
      session = null;
      validatedSinceLoad = true;
      validationAfter = now() + TOKEN_VALIDATE_INTERVAL_MS;
      lastError = "";
      persist();
      syncMonitor();
      void reconcileManagedRewards(true);
      void refreshRoleDirectory(true);
      return { ok: true };
    })().finally(() => { refreshInFlight = null; });
    return refreshInFlight;
  }

  async function withAuthorization(operation, requiredScopes = []) {
    if (!profile.clientId || !profile.refreshToken || !profile.userId) return { ok: false, error: "twitch_not_connected", retryable: false };
    if (!profile.accessToken || profile.expiresAt <= now()) {
      const refreshed = await refreshAuthorization();
      if (!refreshed.ok) return refreshed;
    }
    const missingScope = requiredScopes.find(scope => !profile.scopes.includes(scope));
    if (missingScope) return { ok: false, error: "twitch_scope_missing", scope: missingScope, retryable: false };
    let result = await operation(credentials());
    if (result?.status !== 401 && result?.error !== "twitch_reauthorization_required") return result;
    const refreshed = await refreshAuthorization();
    if (!refreshed.ok) return refreshed;
    result = await operation(credentials());
    return result;
  }

  async function validateAuthorization(force = false) {
    if (!profile.accessToken || !profile.clientId || !profile.userId) return { ok: false, error: "twitch_not_connected" };
    if (!force && validationAfter > now()) return { ok: true, skipped: true };
    if (validationInFlight) return validationInFlight;
    validationInFlight = (async () => {
      const previousScopes = [...profile.scopes];
      const validated = await api.validateToken(profile.accessToken);
      if (!validated.ok) {
        lastError = text(validated.error || "twitch_validate_failed", 120);
        validationAfter = now() + VALIDATION_RETRY_MS;
        if (validated.error !== "twitch_token_invalid") return { ok: false, error: lastError, retryable: true };
        profile = { ...profile, accessToken: "", expiresAt: 0 };
        validatedSinceLoad = false;
        persist();
        monitor?.stop?.();
        return refreshAuthorization();
      }
      if (validated.clientId !== profile.clientId || validated.userId !== profile.userId) {
        lastError = "twitch_token_identity_mismatch";
        profile = { ...profile, accessToken: "", refreshToken: "", userId: "", login: "", scopes: [], expiresAt: 0 };
        validatedSinceLoad = false;
        persist();
        monitor?.stop?.();
        return { ok: false, error: lastError, retryable: false };
      }
      profile = {
        ...profile,
        login: validated.login,
        scopes: validated.scopes,
        expiresAt: now() + Math.max(1, validated.expiresIn) * 1000
      };
      validatedSinceLoad = true;
      validationAfter = now() + TOKEN_VALIDATE_INTERVAL_MS;
      lastError = "";
      persist();
      syncMonitor(previousScopes.join("\0") !== profile.scopes.join("\0"));
      void refreshRoleDirectory(true);
      return { ok: true };
    })().finally(() => { validationInFlight = null; });
    return validationInFlight;
  }

  function syncMonitor(restart = false) {
    const connected = Boolean(profile.accessToken && profile.refreshToken && profile.userId && profile.expiresAt > now());
    const redemptionAuthorized = profile.scopes.includes("channel:manage:redemptions");
    if (connected && validatedSinceLoad && redemptionAuthorized && monitorAvailable && profile.monitorConfig?.intakeMode === "native") {
      if (restart) monitor?.restart?.();
      else monitor?.start?.();
    }
    else monitor?.stop?.();
  }

  async function reconcileManagedRewards(force = false) {
    if (!Object.keys(profile.managedRewards || {}).length) return;
    if (!force && rewardReconcileAfter > now()) return;
    if (rewardReconcileInFlight) return rewardReconcileInFlight;
    rewardReconcileInFlight = (async () => {
      let changed = false;
      for (const [purpose, row] of Object.entries(profile.managedRewards || {})) {
        const inspected = await withAuthorization(current => api.inspectReward({ rewardId: row.rewardId, credentials: current }));
        if (inspected?.ok && inspected.exists === false) { delete profile.managedRewards[purpose]; changed = true; }
      }
      if (changed) persist();
      rewardReconcileAfter = now() + 30000;
    })().finally(() => { rewardReconcileInFlight = null; });
    return rewardReconcileInFlight;
  }

  async function ensureStatus() {
    if (profile.clientId && profile.refreshToken && profile.userId && (!profile.accessToken || profile.expiresAt <= now())) void refreshAuthorization();
    if (profile.accessToken && profile.expiresAt > now()) {
      void validateAuthorization();
      if (validatedSinceLoad) {
        void reconcileManagedRewards();
        void refreshRoleDirectory();
      }
    }
    syncMonitor();
    return status();
  }

  async function settle(input) {
    const rewardId = text(input?.rewardId, 160);
    const managed = Object.values(profile.managedRewards || {}).some(row => row.rewardId === rewardId);
    if (!managed) return { ok: false, error: "twitch_reward_not_managed", retryable: false };
    if (input?.broadcasterId && text(input.broadcasterId, 80) !== profile.userId) {
      return { ok: false, error: "twitch_broadcaster_mismatch", retryable: false };
    }
    return withAuthorization(current => api.settleRedemption({ ...input, credentials: current }), ["channel:manage:redemptions"]);
  }
  async function inspectReward(input) {
    return withAuthorization(current => api.inspectReward({ ...input, credentials: current }), ["channel:manage:redemptions"]);
  }
  async function createReward(input = {}) {
    const purpose = text(input.purpose, 40).toLowerCase();
    if (!REWARD_PURPOSES.has(purpose)) return { ok: false, error: "twitch_reward_purpose_invalid" };
    const existing = profile.managedRewards?.[purpose];
    if (existing) {
      const inspected = await withAuthorization(current => api.inspectReward({ rewardId: existing.rewardId, credentials: current }), ["channel:manage:redemptions"]);
      if (!inspected?.ok) return inspected;
      if (inspected.exists) return { ok: false, error: "twitch_reward_purpose_exists" };
      delete profile.managedRewards[purpose];
      persist();
    }
    const result = await withAuthorization(current => api.createReward({ ...input, credentials: current }), ["channel:manage:redemptions"]);
    if (!result.ok) return result;
    profile.managedRewards = { ...(profile.managedRewards || {}), [purpose]: { purpose, rewardId: result.rewardId, title: result.title, cost: result.cost } };
    persist();
    return { ...result, purpose };
  }
  async function sendChat(input) {
    return withAuthorization(current => api.sendChat({ ...input, credentials: current }), ["user:write:chat"]);
  }
  async function refreshRoleDirectory(force = false) {
    if (!force && roleDirectoryAfter > now()) return { ok: true, skipped: true };
    if (roleDirectoryInFlight) return roleDirectoryInFlight;
    if (typeof api.listRequesterRoles !== "function") {
      roleDirectoryAfter = now() + ROLE_DIRECTORY_RETRY_MS;
      roleDirectoryLastError = "twitch_role_directory_unavailable";
      return { ok: false, error: roleDirectoryLastError };
    }
    roleDirectoryInFlight = (async () => {
      const result = await withAuthorization(current => api.listRequesterRoles({ credentials: current }), ["channel:read:vips", "moderation:read"]);
      if (!result?.ok) {
        roleDirectoryAfter = now() + ROLE_DIRECTORY_RETRY_MS;
        roleDirectoryLastError = text(result?.error || "twitch_role_list_failed", 120);
        return result;
      }
      const next = new Map();
      for (const id of (result.vips || []).slice(0, 1000)) next.set(text(id, 80), "vip");
      for (const id of (result.moderators || []).slice(0, 1000)) next.set(text(id, 80), "moderator");
      roleDirectory = next;
      roleDirectoryAfter = now() + ROLE_DIRECTORY_TTL_MS;
      roleDirectoryUpdatedAt = now();
      roleDirectoryLastError = "";
      return { ok: true, moderators: result.moderators.length, vips: result.vips.length };
    })().finally(() => { roleDirectoryInFlight = null; });
    return roleDirectoryInFlight;
  }
  function observeRequesterRole(userId, role) {
    const id = text(userId, 80);
    if (!id || !["viewer", "vip", "moderator"].includes(role)) return false;
    if (role === "viewer") roleDirectory.delete(id);
    else roleDirectory.set(id, role);
    roleDirectoryUpdatedAt = now();
    return true;
  }
  async function resolveRequesterRole(userId) {
    const id = text(userId, 80);
    if (!id) return { ok: false, role: "viewer", error: "twitch_user_id_required" };
    if (id === profile.userId) return { ok: true, role: "moderator", source: "broadcaster" };
    await refreshRoleDirectory();
    return { ok: true, role: roleDirectory.get(id) || "viewer", source: "directory" };
  }
  async function configureMonitor(input = {}) {
    const next = normalizeMonitorConfig(input);
    const subscriptionsChanged = next.intakeMode !== profile.monitorConfig.intakeMode;
    profile.monitorConfig = next;
    publishIntakeMode();
    persist();
    syncMonitor(subscriptionsChanged);
    return status();
  }
  function suspendMonitor() { monitor?.stop?.(); }
  async function shutdown() { session = null; monitor?.stop?.(); }

  load();
  monitor = (options.eventSubMonitorFactory || createTwitchEventSubMonitor)({
    WebSocket: options.WebSocket,
    now,
    getCredentials: credentials,
    onSessionActivity: () => { void validateAuthorization(); },
    getSubscriptionConfig: () => ({
      redemptions: profile.scopes.includes("channel:manage:redemptions"),
      chat: profile.scopes.includes("user:read:chat")
    }),
    createSubscription: input => withAuthorization(
      current => api.createEventSubSubscription({ ...input, credentials: current }),
      [input.type === "channel.chat.message" ? "user:read:chat" : "channel:manage:redemptions"]
    ),
    onRedemption: event => options.onRedemption?.(event, { ...profile.managedRewards }),
    onChat: event => options.onChat?.(event, { ...profile.monitorConfig })
  });
  return Object.freeze({ status, ensureStatus, configure, configureMonitor, suspendMonitor, clearClientId, begin, poll, disconnect, inspectReward, createReward, observeRequesterRole, refreshRoleDirectory, resolveRequesterRole, settle, sendChat, shutdown });
};
