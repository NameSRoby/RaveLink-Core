const TOKEN_VALIDATE_INTERVAL_MS = 60 * 60 * 1000;
const VALIDATION_RETRY_MS = 60 * 1000;
module.exports = function createAuthorization(state, hooks) {
  const { api, now, text, persist, credentials, syncMonitor, runBackground, reconcileManagedRewards, refreshRoleDirectory, monitorStop, onAuthorizationLost, onScopesChanged } = hooks;
  async function refreshAuthorization() {
    if (state.refreshInFlight) return state.refreshInFlight;
    state.refreshInFlight = (async () => {
      if (!state.profile.clientId || !state.profile.refreshToken || !state.profile.userId) return { ok: false, error: "twitch_reauthorization_required", retryable: false };
      state.validatedSinceLoad = false;
      const previousUserId = state.profile.userId;
      const refreshed = await api.refreshUserAccessToken({ clientId: state.profile.clientId, refreshToken: state.profile.refreshToken });
      if (!refreshed.ok) {
        state.lastError = text(refreshed.error || "twitch_reauthorization_required", 120);
        const definitive = refreshed.error === "twitch_reauthorization_required" && [400, 401].includes(Number(refreshed.status || 0));
        state.profile = { ...state.profile, accessToken: "", expiresAt: 0, ...(definitive ? { refreshToken: "" } : {}) };
        if (definitive) { onAuthorizationLost(); persist(); }
        return { ok: false, error: state.lastError, status: refreshed.status || 0, retryable: !definitive };
      }
      // Device-flow refresh tokens rotate on use. Save the replacement before any
      // later network operation so a validation outage cannot strand the grant.
      state.profile = {
        ...state.profile,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: now() + Math.max(1, refreshed.expiresIn) * 1000
      };
      persist();
      const validated = await api.validateToken(refreshed.accessToken);
      if (!validated.ok || validated.clientId !== state.profile.clientId || validated.userId !== previousUserId) {
        state.lastError = text(validated.error || "twitch_token_identity_mismatch", 120);
        const definitive = validated.error === "twitch_token_invalid" || (validated.ok && (validated.clientId !== state.profile.clientId || validated.userId !== previousUserId));
        state.profile = { ...state.profile, accessToken: "", expiresAt: 0, ...(definitive ? { refreshToken: "" } : {}) };
        if (definitive) { onAuthorizationLost(); persist(); }
        return { ok: false, error: state.lastError, retryable: !definitive };
      }
      if (state.profile.scopes.join("\0") !== validated.scopes.join("\0")) onScopesChanged();
      state.profile = {
        ...state.profile,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        login: validated.login,
        scopes: validated.scopes,
        expiresAt: now() + Math.max(1, validated.expiresIn || refreshed.expiresIn) * 1000
      };
      state.session = null;
      state.validatedSinceLoad = true;
      state.validationAfter = now() + TOKEN_VALIDATE_INTERVAL_MS;
      state.lastError = "";
      persist();
      syncMonitor(true);
      runBackground(() => reconcileManagedRewards(true), "twitch_reward_sync_failed");
      runBackground(() => refreshRoleDirectory(true), "twitch_role_refresh_failed");
      return { ok: true };
    })().finally(() => { state.refreshInFlight = null; });
    return state.refreshInFlight;
  }

  async function authorize(operation, requiredScopes = []) {
    if (state.profile.authorizationRecovery?.reauthorizationRequired) return { ok: false, error: 'twitch_not_connected', retryable: false };
    if (!state.profile.clientId || !state.profile.refreshToken || !state.profile.userId) return { ok: false, error: "twitch_not_connected", retryable: false };
    if (!state.profile.accessToken || state.profile.expiresAt <= now()) {
      const refreshed = await refreshAuthorization();
      if (!refreshed.ok) return refreshed;
    }
    if (!state.validatedSinceLoad) { const validated = await validateAuthorization(true); if (!validated.ok) return validated; }
    const missingScope = requiredScopes.find(scope => !state.profile.scopes.includes(scope));
    if (missingScope) return { ok: false, error: "twitch_scope_missing", scope: missingScope, retryable: false };
    let result = await operation(credentials());
    if (result?.status !== 401 && result?.error !== "twitch_reauthorization_required") return result;
    const refreshed = await refreshAuthorization();
    if (!refreshed.ok) return refreshed;
    const changedScope = requiredScopes.find(scope => !state.profile.scopes.includes(scope));
    if (changedScope) return { ok: false, error: "twitch_scope_missing", scope: changedScope, retryable: false };
    result = await operation(credentials());
    return result;
  }

  async function validateAuthorization(force = false) {
    if (!state.profile.accessToken || !state.profile.clientId || !state.profile.userId) return { ok: false, error: "twitch_not_connected" };
    if (!force && state.validationAfter > now()) return { ok: true, skipped: true };
    if (state.validationInFlight) return state.validationInFlight;
    state.validationInFlight = (async () => {
      const previousScopes = [...state.profile.scopes];
      const validated = await api.validateToken(state.profile.accessToken);
      if (!validated.ok) {
        state.lastError = text(validated.error || "twitch_validate_failed", 120);
        state.validationAfter = now() + VALIDATION_RETRY_MS;
        if (validated.error !== "twitch_token_invalid") return { ok: false, error: state.lastError, retryable: true };
        state.profile = { ...state.profile, accessToken: "", expiresAt: 0 };
        state.validatedSinceLoad = false;
        persist();
        monitorStop();
        return refreshAuthorization();
      }
      if (validated.clientId !== state.profile.clientId || validated.userId !== state.profile.userId) {
        state.lastError = "twitch_token_identity_mismatch";
        state.profile = { ...state.profile, accessToken: "", refreshToken: "", userId: "", login: "", scopes: [], expiresAt: 0 };
        state.validatedSinceLoad = false;
        onAuthorizationLost();
        persist();
        monitorStop();
        return { ok: false, error: state.lastError, retryable: false };
      }
      if (previousScopes.join("\0") !== validated.scopes.join("\0")) onScopesChanged();
      state.profile = {
        ...state.profile,
        login: validated.login,
        scopes: validated.scopes,
        expiresAt: now() + Math.max(1, validated.expiresIn) * 1000
      };
      state.validatedSinceLoad = true;
      state.validationAfter = now() + TOKEN_VALIDATE_INTERVAL_MS;
      state.lastError = "";
      persist();
      syncMonitor(previousScopes.join("\0") !== state.profile.scopes.join("\0"));
      runBackground(() => refreshRoleDirectory(true), "twitch_role_refresh_failed");
      return { ok: true };
    })().finally(() => { state.validationInFlight = null; });
    return state.validationInFlight;
  }

  async function withAuthorization(operation, scopes = []) {
    try { return await authorize(operation, scopes); }
    catch (error) {
      if (error?.code !== 'twitch_authorization_changed') throw error;
      return { ok: false, error: error.code, retryable: false };
    }
  }
  return { refreshAuthorization, validateAuthorization, withAuthorization };
};
