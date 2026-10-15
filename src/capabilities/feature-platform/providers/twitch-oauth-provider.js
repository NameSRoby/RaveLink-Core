const fs = require("node:fs");
const path = require("node:path");
const createTransactionJournal = require('./twitch-transaction-journal');
const { readJsonFileWithMetadata, writeJsonFile } = require("../../../shared/fs/json-file-store");
const { protectTextMapWithWindowsDpapi, unprotectTextMapWithWindowsDpapi } = require("../../../shared/security/windows-dpapi");
const { DEFAULT_SCOPES, normalizeScopes, createTwitchApiClient } = require("./twitch-api-client");
const createTwitchEventSubMonitor = require("./twitch-eventsub-monitor");

function text(value, maximum = 2048) { return String(value ?? "").trim().slice(0, maximum); }
const REWARD_PURPOSES = new Set(["lights", "teach", "song_request"]);
const DEFAULT_MONITOR_CONFIG = Object.freeze({ intakeMode: "native", songRequestChatEnabled: false });
const TOKEN_VALIDATE_INTERVAL_MS = 60 * 60 * 1000;
const ROLE_DIRECTORY_TTL_MS = 30 * 60 * 1000;
const ROLE_DIRECTORY_RETRY_MS = 60 * 1000;
const REWARD_CATALOG_TTL_MS = 30 * 1000;
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
  const journal = createTransactionJournal({ filename: options.journalPath || (vaultPath ? path.join(path.dirname(vaultPath), 'twitch-transactions.json') : ''), now });
  const rawApi = options.api || createTwitchApiClient(options);
  const recovery = require("./twitch-authorization-recovery")({
    getProfile: () => profile, setProfile: value => { profile = value; },
    onInvalidated: () => { validatedSinceLoad = false; session = null; monitor?.stop?.(); clearRewardCatalog(); roleDirectory.clear(); roleDirectoryAfter = 0; },
    onRevoked: reason => { lastError = `twitch_${reason}`; persist(); syncMonitor(); }
  });
  const api = recovery.guardApi(rawApi);
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
  let rewardPauseChain = Promise.resolve();
  const rewardCreationInFlight = new Set();
  let rewardCatalog = [];
  let rewardCatalogAfter = 0;
  let rewardCatalogInFlight = null;
  let monitor;
  let roleDirectory = new Map();
  let roleDirectoryAfter = 0;
  let roleDirectoryInFlight = null;
  let roleDirectoryUpdatedAt = 0;
  let roleDirectoryLastError = "";
  const monitorAvailable = typeof api.createEventSubSubscription === "function";
  function clearRewardCatalog() { rewardCatalog = []; rewardCatalogAfter = 0; }
  function subscriptionScopes(type) {
    const fixed = { "channel.chat.message": "user:read:chat", "channel.channel_points_custom_reward_redemption.add": "channel:manage:redemptions" };
    const scope = fixed[type];
    return scope ? [scope] : [];
  }

  function runBackground(operation, fallback = "twitch_background_operation_failed") {
    Promise.resolve().then(operation).catch(error => {
      if (error?.code !== "twitch_authorization_changed") lastError = text(error?.code || error?.message || fallback, 120) || fallback;
    });
  }

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
        monitorConfig: normalizeMonitorConfig(JSON.parse(decoded.plain.monitorConfig || "{}")),
        rewardOwnerUserId: text(decoded.plain.rewardOwnerUserId || decoded.plain.userId, 80),
        authorizationRecovery: recovery.normalize(JSON.parse(decoded.plain.authorizationRecovery || "{}"))
      };
      if (recovery.snapshot().reauthorizationRequired) profile = { ...profile, accessToken: "", refreshToken: "", scopes: [], expiresAt: 0 };
    } catch (error) { lastError = text(error?.message || "twitch_vault_load_failed", 120); }
    publishIntakeMode();
  }

  function persist() {
    if (!vaultPath) return false;
    if (process.platform !== "win32") return true;
    const encoded = protectTextMapWithWindowsDpapi({
      clientId: profile.clientId, accessToken: profile.accessToken, refreshToken: profile.refreshToken,
      userId: profile.userId, login: profile.login, scopes: JSON.stringify(profile.scopes), expiresAt: String(profile.expiresAt),
      rewardOwnerUserId: profile.rewardOwnerUserId || profile.userId, authorizationRecovery: JSON.stringify(recovery.snapshot()),
      managedRewards: JSON.stringify(profile.managedRewards || {}), monitorConfig: JSON.stringify(profile.monitorConfig || DEFAULT_MONITOR_CONFIG)
    });
    if (!encoded.ok) { lastError = text(encoded.error || "twitch_vault_encrypt_failed", 120); return false; }
    writeJsonFile(vaultPath, { version: 1, provider: "windows_dpapi", updatedAt: now(), encrypted: encoded.encrypted }, { mode: 0o600 });
    return true;
  }

  function status() {
    const connected = Boolean(validatedSinceLoad && !recovery.snapshot().reauthorizationRequired && profile.accessToken && profile.refreshToken && profile.userId && profile.expiresAt > now());
    return {
      ok: true, configured: Boolean(profile.clientId), connected, authorizationRecovery: recovery.snapshot(),
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
      recovery.invalidate();
      monitor?.stop?.();
      clearRewardCatalog();
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
    const previous = credentials();
    recovery.invalidate();
    monitor?.stop?.();
    clearRewardCatalog();
    profile = { clientId: "", accessToken: "", refreshToken: "", userId: "", login: "", scopes: [], expiresAt: 0, managedRewards: {}, monitorConfig: { ...DEFAULT_MONITOR_CONFIG } };
    roleDirectory = new Map();
    roleDirectoryAfter = 0;
    roleDirectoryUpdatedAt = 0;
    roleDirectoryLastError = "";
    publishIntakeMode();
    session = null;
    lastError = "";
    persist();
    syncMonitor();
    await rawApi.revokeToken?.({ clientId: previous.clientId, accessToken: previous.accessToken });
    return status();
  }

  async function begin(input = {}) {
    const request = input && typeof input === "object" ? input : {};
    if (!profile.clientId) return { ...status(), ok: false, error: "twitch_client_id_required" };
    recovery.invalidate();
    profile = { ...profile, accessToken: "", refreshToken: "", scopes: [], expiresAt: 0 };
    persist();
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
      managedRewards: (profile.rewardOwnerUserId || profile.userId) === validated.userId ? profile.managedRewards || {} : {},
      rewardOwnerUserId: validated.userId, authorizationRecovery: recovery.afterLogin(), monitorConfig: profile.monitorConfig || { ...DEFAULT_MONITOR_CONFIG }
    };
    session = null;
    validatedSinceLoad = true;
    validationAfter = now() + TOKEN_VALIDATE_INTERVAL_MS;
    lastError = "";
    persist();
    monitor?.clearRevocations?.();
    syncMonitor();
    runBackground(() => refreshRoleDirectory(true), "twitch_role_refresh_failed");
    return status();
  }

  async function disconnect() {
    const previous = credentials();
    recovery.invalidate();
    profile = { ...profile, accessToken: "", refreshToken: "", userId: "", login: "", scopes: [], expiresAt: 0 };
    clearRewardCatalog();
    roleDirectory = new Map();
    roleDirectoryAfter = 0;
    roleDirectoryUpdatedAt = 0;
    roleDirectoryLastError = "";
    session = null;
    monitor?.stop?.();
    lastError = "";
    persist();
    await rawApi.revokeToken?.({ clientId: previous.clientId, accessToken: previous.accessToken });
    return status();
  }

  function credentials() { return { ...profile, scopes: [...profile.scopes] }; }

  function syncMonitor(restart = false) {
    const connected = status().connected;
    const anyAuthorized = canSubscribe("channel.channel_points_custom_reward_redemption.add", "1") || canSubscribe("channel.chat.message", "1");
    if (connected && anyAuthorized && monitorAvailable && profile.monitorConfig?.intakeMode === "native") {
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
        if (inspected?.ok && inspected.exists === false && profile.managedRewards[purpose]?.rewardId === row.rewardId) { delete profile.managedRewards[purpose]; changed = true; clearRewardCatalog(); }
      }
      if (changed) persist();
      rewardReconcileAfter = now() + 30000;
    })().finally(() => { rewardReconcileInFlight = null; });
    return rewardReconcileInFlight;
  }

  async function ensureStatus() {
    if (profile.clientId && profile.refreshToken && profile.userId && (!profile.accessToken || profile.expiresAt <= now())) runBackground(refreshAuthorization, "twitch_refresh_failed");
    if (profile.accessToken && profile.expiresAt > now()) {
      runBackground(validateAuthorization, "twitch_validate_failed");
      if (validatedSinceLoad) {
        runBackground(reconcileManagedRewards, "twitch_reward_sync_failed");
        runBackground(refreshRoleDirectory, "twitch_role_refresh_failed");
      }
    }
    syncMonitor();
    return status();
  }

  const authState = {
    get profile() { return profile; }, set profile(value) { profile = value; },
    get session() { return session; }, set session(value) { session = value; },
    get lastError() { return lastError; }, set lastError(value) { lastError = value; },
    get refreshInFlight() { return refreshInFlight; }, set refreshInFlight(value) { refreshInFlight = value; },
    get validationInFlight() { return validationInFlight; }, set validationInFlight(value) { validationInFlight = value; },
    get validationAfter() { return validationAfter; }, set validationAfter(value) { validationAfter = value; },
    get validatedSinceLoad() { return validatedSinceLoad; }, set validatedSinceLoad(value) { validatedSinceLoad = value; },
  };
  const { refreshAuthorization, validateAuthorization, withAuthorization } = require('./twitch-authorization')(authState, { api, now, text, persist, credentials, syncMonitor, runBackground, reconcileManagedRewards, refreshRoleDirectory, monitorStop: () => monitor?.stop?.(), onScopesChanged: () => recovery.invalidate(), onAuthorizationLost: () => recovery.revoke({ type: "channel.channel_points_custom_reward_redemption.add", version: "1", reason: "authorization_revoked" }) });
  const { settle, reviewTransactions, reconcileTransaction, receiveRedemption } = require('./twitch-transactions')({ journal, getProfile: () => profile, withAuthorization, api, onRedemption: options.onRedemption, now });
  async function inspectReward(input) {
    return withAuthorization(current => api.inspectReward({ ...input, credentials: current }), ["channel:manage:redemptions"]);
  }
  async function listRewards(input = {}) {
    const cached = input.force !== true && rewardCatalogAfter > now()
      ? { ok: true, rewards: rewardCatalog.map(row => ({ ...row })), events: [], cached: true }
      : null;
    return cached || rewardCatalogInFlight || (rewardCatalogInFlight = (async () => {
      const result = await withAuthorization(current => api.listRewards({ credentials: current }), ["channel:manage:redemptions"]);
      return result?.ok ? (() => {
        const purposes = new Map(Object.values(profile.managedRewards || {}).map(row => [row.rewardId, row.purpose]));
        rewardCatalog = result.rewards.slice(0, 50).map(row => ({ ...row, managedPurpose: purposes.get(row.id) || "" }));
        rewardCatalogAfter = now() + REWARD_CATALOG_TTL_MS;
        return { ok: true, rewards: rewardCatalog.map(row => ({ ...row })), events: [], cached: false };
      })() : result;
    })().finally(() => { rewardCatalogInFlight = null; }));
  }
  async function createReward(input = {}) {
    const purpose = text(input.purpose, 40).toLowerCase();
    if (!REWARD_PURPOSES.has(purpose)) return { ok: false, error: "twitch_reward_purpose_invalid" };
    if (rewardCreationInFlight.has(purpose)) return { ok: false, error: "twitch_reward_creation_in_progress", retryable: false };
    rewardCreationInFlight.add(purpose);
    try { return await createManagedReward(input, purpose); }
    finally { rewardCreationInFlight.delete(purpose); }
  }
  async function createManagedReward(input, purpose) {
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
    rewardCatalogAfter = 0;
    persist();
    return { ...result, purpose };
  }
  async function setManagedRewardPaused(input = {}) {
    const purpose = text(input.purpose, 40).toLowerCase();
    const managed = profile.managedRewards?.[purpose];
    if (!REWARD_PURPOSES.has(purpose) || !managed?.rewardId) return { ok: false, error: "twitch_reward_not_managed", retryable: false };
    const ownerId = profile.userId;
    const operation = rewardPauseChain.then(() => withAuthorization(
      current => profile.userId !== ownerId || profile.managedRewards?.[purpose]?.rewardId !== managed.rewardId
        ? { ok: false, error: "twitch_reward_changed", retryable: false }
        : api.setRewardPaused({ rewardId: managed.rewardId, paused: input.paused === true, credentials: current }),
      ["channel:manage:redemptions"]
    ));
    rewardPauseChain = operation.catch(() => null);
    return operation;
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
  function refreshSubscriptions() { syncMonitor(true); }
  async function shutdown() { recovery.invalidate(); monitor?.stop?.(); }

  function canSubscribe(type, version) { const known = ["channel.chat.message", "channel.channel_points_custom_reward_redemption.add"].includes(type); return known && subscriptionScopes(type).every(scope => profile.scopes.includes(scope)) && recovery.allowed(type, version); }
  function canReceive(type, version) { return status().connected && canSubscribe(type, version); }

  load();
  monitor = (options.eventSubMonitorFactory || createTwitchEventSubMonitor)({
    WebSocket: options.WebSocket,
    now,
    getCredentials: credentials,
    onSessionActivity: () => { runBackground(validateAuthorization, "twitch_validate_failed"); },
    getSubscriptionConfig: () => ({
      redemptions: canSubscribe("channel.channel_points_custom_reward_redemption.add", "1"),
      chat: canSubscribe("channel.chat.message", "1"),
      events: []
    }),
    createSubscription: input => withAuthorization(
      current => api.createEventSubSubscription({ ...input, credentials: current }),
      subscriptionScopes(input.type)
    ),
    onRevocation: row => recovery.revoke(row),
    onRedemption: event => canReceive("channel.channel_points_custom_reward_redemption.add", "1") ? receiveRedemption(event) : undefined,
    onChat: event => canReceive("channel.chat.message", "1") ? options.onChat?.(event, { ...profile.monitorConfig }) : undefined
  });
  return Object.freeze({ status, ensureStatus, configure, configureMonitor, suspendMonitor, refreshSubscriptions, clearClientId, begin, poll, disconnect, inspectReward, listRewards, createReward, setManagedRewardPaused, observeRequesterRole, refreshRoleDirectory, resolveRequesterRole, settle, reviewTransactions, reconcileTransaction, sendChat, shutdown });
};
