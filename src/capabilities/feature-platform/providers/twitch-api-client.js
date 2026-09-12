const TWITCH_IDENTITY = "https://id.twitch.tv/oauth2";
const TWITCH_HELIX = "https://api.twitch.tv/helix";
const DEFAULT_SCOPES = Object.freeze([
  "channel:manage:redemptions",
  "channel:read:vips",
  "moderation:read",
  "user:read:chat",
  "user:write:chat"
]);
const ALLOWED_SCOPES = new Set(DEFAULT_SCOPES);

function text(value, maximum = 512) {
  return String(value ?? "").trim().slice(0, maximum);
}

function normalizeScopes(input, fallback = DEFAULT_SCOPES) {
  const source = Array.isArray(input) ? input : fallback;
  return [...new Set(source.map(value => text(value, 80)).filter(value => ALLOWED_SCOPES.has(value)))].sort();
}

function createTwitchApiClient(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  const timeoutMs = Math.max(1000, Math.min(10000, Number(options.timeoutMs || 5000)));
  if (typeof fetchImpl !== "function") throw new Error("twitch_fetch_unavailable");

  async function request(url, init = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    try {
      const response = await fetchImpl(url, { ...init, signal: controller.signal });
      const raw = await response.text();
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
      return { ok: response.ok, status: response.status, body };
    } catch (error) {
      return { ok: false, status: 0, body: {}, error: error?.name === "AbortError" ? "twitch_request_timeout" : "twitch_network_unavailable" };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function beginDeviceAuthorization(input = {}) {
    const clientId = text(input.clientId, 80);
    const scopes = normalizeScopes(input.scopes);
    if (!clientId || !scopes.length) return { ok: false, error: "twitch_client_id_required" };
    const body = new URLSearchParams({ client_id: clientId, scopes: scopes.join(" ") });
    const result = await request(`${TWITCH_IDENTITY}/device`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    if (!result.ok) return { ok: false, error: result.error || "twitch_device_authorization_failed", status: result.status };
    const deviceCode = text(result.body.device_code, 512);
    const userCode = text(result.body.user_code, 64);
    const verificationUri = text(result.body.verification_uri, 512);
    if (!deviceCode || !userCode || !verificationUri) return { ok: false, error: "twitch_device_response_invalid" };
    return {
      ok: true, deviceCode, userCode, verificationUri, scopes,
      expiresIn: Math.max(60, Math.min(1800, Number(result.body.expires_in || 1800))),
      interval: Math.max(1, Math.min(30, Number(result.body.interval || 5)))
    };
  }

  async function pollDeviceAuthorization(input = {}) {
    const clientId = text(input.clientId, 80);
    const deviceCode = text(input.deviceCode, 512);
    const scopes = normalizeScopes(input.scopes);
    if (!clientId || !deviceCode) return { ok: false, error: "twitch_device_session_missing" };
    const body = new URLSearchParams({
      client_id: clientId,
      scopes: scopes.join(" "),
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code"
    });
    const result = await request(`${TWITCH_IDENTITY}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    if (!result.ok) {
      const message = text(result.body.message, 120).toLowerCase().replace(/\s+/g, "_");
      if (message === "authorization_pending") return { ok: true, pending: true };
      return { ok: false, error: message === "slow_down" ? "twitch_poll_too_fast" : "twitch_device_authorization_failed", status: result.status };
    }
    const accessToken = text(result.body.access_token, 2048);
    const refreshToken = text(result.body.refresh_token, 2048);
    if (!accessToken || !refreshToken) return { ok: false, error: "twitch_token_response_invalid" };
    return { ok: true, pending: false, accessToken, refreshToken, expiresIn: Math.max(1, Number(result.body.expires_in || 0)), scopes: normalizeScopes(result.body.scope, []) };
  }

  async function validateToken(accessToken) {
    const token = text(accessToken, 2048);
    if (!token) return { ok: false, error: "twitch_access_token_missing" };
    const result = await request(`${TWITCH_IDENTITY}/validate`, { headers: { Authorization: `OAuth ${token}` } });
    if (!result.ok) return { ok: false, error: result.status === 401 ? "twitch_token_invalid" : (result.error || "twitch_validate_failed"), status: result.status };
    return {
      ok: true,
      clientId: text(result.body.client_id, 80),
      userId: text(result.body.user_id, 80),
      login: text(result.body.login, 80),
      scopes: normalizeScopes(result.body.scopes, []),
      expiresIn: Math.max(0, Number(result.body.expires_in || 0))
    };
  }

  async function refreshUserAccessToken(input = {}) {
    const clientId = text(input.clientId, 80);
    const refreshToken = text(input.refreshToken, 2048);
    if (!clientId || !refreshToken) return { ok: false, error: "twitch_refresh_token_missing", status: 0 };
    const body = new URLSearchParams({ client_id: clientId, grant_type: "refresh_token", refresh_token: refreshToken });
    const result = await request(`${TWITCH_IDENTITY}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body
    });
    if (!result.ok) {
      return {
        ok: false,
        error: result.status === 400 || result.status === 401 ? "twitch_reauthorization_required" : (result.error || "twitch_refresh_failed"),
        status: result.status
      };
    }
    const accessToken = text(result.body.access_token, 2048);
    const nextRefreshToken = text(result.body.refresh_token, 2048);
    if (!accessToken || !nextRefreshToken) return { ok: false, error: "twitch_refresh_response_invalid", status: result.status };
    return {
      ok: true,
      accessToken,
      refreshToken: nextRefreshToken,
      expiresIn: Math.max(1, Number(result.body.expires_in || 0)),
      scopes: normalizeScopes(result.body.scope, [])
    };
  }

  async function revokeToken(input = {}) {
    const clientId = text(input.clientId, 80);
    const token = text(input.accessToken, 2048);
    if (!clientId || !token) return { ok: true, skipped: true };
    const body = new URLSearchParams({ client_id: clientId, token });
    const result = await request(`${TWITCH_IDENTITY}/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    return result.ok ? { ok: true, skipped: false } : { ok: false, error: result.error || "twitch_revoke_failed", status: result.status };
  }

  async function settleRedemption(input = {}) {
    const credentials = input.credentials || {};
    const status = input.status === "FULFILLED" ? "FULFILLED" : input.status === "CANCELED" ? "CANCELED" : "";
    const broadcasterId = text(input.broadcasterId || credentials.userId, 80);
    const rewardId = text(input.rewardId, 160);
    const redemptionId = text(input.redemptionId, 160);
    if (!status || !broadcasterId || !rewardId || !redemptionId) return { ok: false, error: "twitch_settlement_invalid" };
    const query = new URLSearchParams({ broadcaster_id: broadcasterId, reward_id: rewardId, id: redemptionId });
    const result = await request(`${TWITCH_HELIX}/channel_points/custom_rewards/redemptions?${query}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${text(credentials.accessToken, 2048)}`, "Client-Id": text(credentials.clientId, 80), "content-type": "application/json" },
      body: JSON.stringify({ status })
    });
    if (!result.ok) return { ok: false, error: result.status === 401 ? "twitch_reauthorization_required" : "twitch_settlement_failed", status: result.status, retryable: result.status === 429 || result.status >= 500 };
    return { ok: true, status, redemptionId, refunded: status === "CANCELED" };
  }

  async function inspectReward(input = {}) {
    const credentials = input.credentials || {};
    const broadcasterId = text(input.broadcasterId || credentials.userId, 80);
    const rewardId = text(input.rewardId, 160);
    const accessToken = text(credentials.accessToken, 2048);
    const clientId = text(credentials.clientId, 80);
    const headers = { Authorization: `Bearer ${accessToken}`, "Client-Id": clientId };
    if (!broadcasterId || !rewardId || !accessToken || !clientId) {
      return { ok: false, error: "twitch_reward_inspection_invalid" };
    }
    const query = new URLSearchParams({ broadcaster_id: broadcasterId, id: rewardId });
    const visible = await request(`${TWITCH_HELIX}/channel_points/custom_rewards?${query}`, { headers });
    if (!visible.ok) {
      if (visible.status === 404) return { ok: true, rewardId, exists: false, manageable: false, title: "" };
      return { ok: false, error: visible.status === 401 ? "twitch_reauthorization_required" : "twitch_reward_inspection_failed", status: visible.status };
    }
    const reward = Array.isArray(visible.body.data) ? visible.body.data.find(row => text(row?.id, 160) === rewardId) : null;
    if (!reward) return { ok: true, rewardId, exists: false, manageable: false, title: "" };
    const manageableQuery = new URLSearchParams({ broadcaster_id: broadcasterId, id: rewardId, only_manageable_rewards: "true" });
    const manageableResult = await request(`${TWITCH_HELIX}/channel_points/custom_rewards?${manageableQuery}`, { headers });
    if (!manageableResult.ok) {
      return { ok: false, error: manageableResult.status === 401 ? "twitch_reauthorization_required" : "twitch_reward_inspection_failed", status: manageableResult.status };
    }
    const manageable = manageableResult.ok && Array.isArray(manageableResult.body.data)
      && manageableResult.body.data.some(row => text(row?.id, 160) === rewardId);
    return { ok: true, rewardId, exists: true, manageable, title: text(reward.title, 45) };
  }

  async function createReward(input = {}) {
    const credentials = input.credentials || {};
    const broadcasterId = text(input.broadcasterId || credentials.userId, 80);
    const accessToken = text(credentials.accessToken, 2048);
    const clientId = text(credentials.clientId, 80);
    const title = text(input.title, 45);
    const prompt = text(input.prompt, 200);
    const cost = Math.trunc(Number(input.cost));
    if (!broadcasterId || !accessToken || !clientId || !title || !Number.isSafeInteger(cost) || cost < 1 || cost > 1000000000) {
      return { ok: false, error: "twitch_reward_create_invalid" };
    }
    const query = new URLSearchParams({ broadcaster_id: broadcasterId });
    const result = await request(`${TWITCH_HELIX}/channel_points/custom_rewards?${query}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Client-Id": clientId, "content-type": "application/json" },
      body: JSON.stringify({
        title,
        cost,
        prompt,
        is_enabled: input.enabled !== false,
        is_user_input_required: true,
        should_redemptions_skip_request_queue: false
      })
    });
    if (!result.ok) {
      const error = result.status === 401
        ? "twitch_reauthorization_required"
        : result.status === 403
          ? "twitch_affiliate_or_partner_required"
          : "twitch_reward_create_failed";
      return { ok: false, error, status: result.status };
    }
    const reward = Array.isArray(result.body.data) ? result.body.data[0] : null;
    const rewardId = text(reward?.id, 160);
    if (!rewardId) return { ok: false, error: "twitch_reward_create_response_invalid" };
    return { ok: true, rewardId, title: text(reward.title, 45) || title, cost: Number(reward.cost || cost), manageable: true };
  }

  async function createEventSubSubscription(input = {}) {
    const credentials = input.credentials || {};
    const type = text(input.type, 100);
    const version = text(input.version, 10);
    const sessionId = text(input.sessionId, 160);
    const condition = input.condition && typeof input.condition === "object" && !Array.isArray(input.condition) ? input.condition : {};
    if (!type || !version || !sessionId || !text(credentials.accessToken, 2048) || !text(credentials.clientId, 80)) {
      return { ok: false, error: "twitch_eventsub_subscription_invalid" };
    }
    const result = await request(`${TWITCH_HELIX}/eventsub/subscriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${text(credentials.accessToken, 2048)}`, "Client-Id": text(credentials.clientId, 80), "content-type": "application/json" },
      body: JSON.stringify({ type, version, condition, transport: { method: "websocket", session_id: sessionId } })
    });
    if (!result.ok) return {
      ok: false,
      error: result.status === 401 ? "twitch_reauthorization_required" : "twitch_eventsub_subscription_failed",
      status: result.status,
      retryable: result.status === 429 || result.status >= 500
    };
    return { ok: true, subscriptionId: text(result.body?.data?.[0]?.id, 160), status: text(result.body?.data?.[0]?.status, 40) };
  }

  async function sendChat(input = {}) {
    const credentials = input.credentials || {};
    const broadcasterId = text(input.broadcasterId || credentials.userId, 80);
    const senderId = text(credentials.userId, 80);
    const message = text(input.message, 500);
    if (!broadcasterId || !senderId || !message) return { ok: false, error: "twitch_chat_request_invalid" };
    const payload = { broadcaster_id: broadcasterId, sender_id: senderId, message };
    const replyParentMessageId = text(input.replyParentMessageId, 160);
    if (replyParentMessageId) payload.reply_parent_message_id = replyParentMessageId;
    const result = await request(`${TWITCH_HELIX}/chat/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${text(credentials.accessToken, 2048)}`, "Client-Id": text(credentials.clientId, 80), "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!result.ok) return { ok: false, error: result.status === 401 ? "twitch_reauthorization_required" : "twitch_chat_send_failed", status: result.status, retryable: result.status === 429 || result.status >= 500 };
    const delivery = Array.isArray(result.body.data) ? result.body.data[0] : null;
    const reason = text(delivery?.drop_reason?.message, 160);
    if (!delivery || delivery.is_sent !== true) return { ok: false, error: "twitch_chat_dropped", status: result.status, retryable: false, reason };
    return { ok: true, messageId: text(delivery.message_id, 160), dropped: false, reason: "" };
  }

  async function listRequesterRoles(input = {}) {
    const credentials = input.credentials || {};
    const broadcasterId = text(input.broadcasterId || credentials.userId, 80);
    const accessToken = text(credentials.accessToken, 2048);
    const clientId = text(credentials.clientId, 80);
    if (!broadcasterId || !accessToken || !clientId) return { ok: false, error: "twitch_role_list_invalid" };
    const headers = { Authorization: `Bearer ${accessToken}`, "Client-Id": clientId };
    async function collect(path) {
      const ids = [];
      let cursor = "";
      for (let page = 0; page < 10 && ids.length < 1000; page += 1) {
        const query = new URLSearchParams({ broadcaster_id: broadcasterId, first: "100" });
        if (cursor) query.set("after", cursor);
        const result = await request(`${TWITCH_HELIX}${path}?${query}`, { headers });
        if (!result.ok) return { ok: false, error: result.status === 401 ? "twitch_reauthorization_required" : "twitch_role_list_failed", status: result.status };
        for (const row of Array.isArray(result.body.data) ? result.body.data : []) {
          const id = text(row?.user_id, 80);
          if (id) ids.push(id);
        }
        cursor = text(result.body?.pagination?.cursor, 160);
        if (!cursor) break;
      }
      return { ok: true, ids: [...new Set(ids)].slice(0, 1000) };
    }
    const moderators = await collect("/moderation/moderators");
    if (!moderators.ok) return moderators;
    const vips = await collect("/channels/vips");
    if (!vips.ok) return vips;
    return { ok: true, moderators: moderators.ids, vips: vips.ids.filter(id => !moderators.ids.includes(id)) };
  }

  return Object.freeze({ beginDeviceAuthorization, pollDeviceAuthorization, refreshUserAccessToken, validateToken, revokeToken, inspectReward, createReward, createEventSubSubscription, listRequesterRoles, settleRedemption, sendChat });
}

module.exports = { ALLOWED_SCOPES, DEFAULT_SCOPES, normalizeScopes, createTwitchApiClient };
