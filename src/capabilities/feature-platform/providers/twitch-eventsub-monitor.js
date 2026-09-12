const EVENTSUB_URL = "wss://eventsub.wss.twitch.tv/ws";
const MAX_SEEN_MESSAGES = 512;
const SEEN_MESSAGE_TTL_MS = 10 * 60 * 1000;
const MAX_IN_FLIGHT = 4;

function createTwitchEventSubMonitor(options = {}) {
  const WebSocketImpl = options.WebSocket || globalThis.WebSocket;
  const createSubscription = options.createSubscription;
  const getCredentials = options.getCredentials;
  const getSubscriptionConfig = options.getSubscriptionConfig;
  const onSessionActivity = options.onSessionActivity || (() => {});
  const onRedemption = options.onRedemption || (async () => {});
  const onChat = options.onChat || (async () => {});
  const now = options.now || Date.now;
  const random = options.random || Math.random;
  let socket = null;
  let pendingSocket = null;
  let timer = null;
  let desired = false;
  let generation = 0;
  let reconnectAttempts = 0;
  let keepaliveTimeoutMs = 15000;
  let lastMessageAt = 0;
  let lifecycle = "stopped";
  let lastError = "";
  let sessionId = "";
  let subscriptions = [];
  let inFlight = 0;
  const seen = new Map();
  const counters = { connections: 0, reconnects: 0, notifications: 0, duplicates: 0, dropped: 0, handlerFailures: 0, redemptions: 0, chatMessages: 0 };

  function clearTimer() { if (timer) clearTimeout(timer); timer = null; }
  function safeUrl(value) {
    try {
      const url = new URL(String(value || ""));
      return url.protocol === "wss:" && url.hostname === "eventsub.wss.twitch.tv" ? url.href : "";
    } catch { return ""; }
  }
  function remember(messageId) {
    const id = String(messageId || "").slice(0, 160);
    if (!id) return false;
    const cutoff = now() - SEEN_MESSAGE_TTL_MS;
    for (const [storedId, storedAt] of seen) {
      if (storedAt > cutoff) break;
      seen.delete(storedId);
    }
    if (seen.has(id)) return true;
    while (seen.size >= MAX_SEEN_MESSAGES) seen.delete(seen.keys().next().value);
    seen.set(id, now());
    return false;
  }
  function snapshot() {
    return {
      enabled: desired,
      lifecycle,
      connected: lifecycle === "connected",
      subscriptions: [...subscriptions],
      lastError,
      lastMessageAt,
      counters: { ...counters }
    };
  }
  function scheduleWatchdog(myGeneration) {
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      if (!desired || myGeneration !== generation) return;
      if (now() - lastMessageAt > keepaliveTimeoutMs + 2500) {
        lastError = "twitch_eventsub_keepalive_timeout";
        try { socket?.close(); } catch {}
      } else scheduleWatchdog(myGeneration);
    }, Math.max(1000, keepaliveTimeoutMs));
    timer.unref?.();
  }
  function scheduleReconnect(myGeneration) {
    if (!desired || myGeneration !== generation || timer) return;
    lifecycle = "reconnecting";
    const base = Math.min(30000, 1000 * (2 ** Math.min(5, reconnectAttempts++)));
    const delay = Math.max(500, Math.round(base * (0.8 + random() * 0.4)));
    timer = setTimeout(() => { timer = null; if (desired && myGeneration === generation) connect(EVENTSUB_URL, myGeneration); }, delay);
    timer.unref?.();
  }
  async function subscribeAll(id, myGeneration) {
    const credentials = getCredentials?.() || {};
    const config = getSubscriptionConfig?.() || { redemptions: true, chat: true };
    const definitions = [
      config.redemptions !== false
        ? { type: "channel.channel_points_custom_reward_redemption.add", version: "1", condition: { broadcaster_user_id: credentials.userId } }
        : null,
      config.chat === true
        ? { type: "channel.chat.message", version: "1", condition: { broadcaster_user_id: credentials.userId, user_id: credentials.userId } }
        : null
    ].filter(Boolean);
    const active = [];
    for (const definition of definitions) {
      if (!desired || myGeneration !== generation) return;
      const result = await createSubscription?.({ ...definition, sessionId: id });
      if (!result?.ok) throw new Error(result?.error || "twitch_eventsub_subscription_failed");
      active.push(definition.type);
    }
    subscriptions = active;
    lifecycle = "connected";
    reconnectAttempts = 0;
    lastError = "";
  }
  function dispatch(type, event) {
    if (inFlight >= MAX_IN_FLIGHT) { counters.dropped += 1; return; }
    inFlight += 1;
    counters.notifications += 1;
    if (type === "channel.channel_points_custom_reward_redemption.add") counters.redemptions += 1;
    if (type === "channel.chat.message") counters.chatMessages += 1;
    const handler = type === "channel.channel_points_custom_reward_redemption.add" ? onRedemption
      : type === "channel.chat.message" ? onChat : null;
    Promise.resolve(handler?.(event)).catch(error => {
      counters.handlerFailures += 1;
      lastError = String(error?.code || error?.message || "twitch_event_handler_failed").slice(0, 120);
    }).finally(() => { inFlight -= 1; });
  }
  function connect(rawUrl, myGeneration, replacement = false) {
    const url = safeUrl(rawUrl);
    if (!url || !desired || myGeneration !== generation) return;
    if (typeof WebSocketImpl !== "function") { lifecycle = "unavailable"; lastError = "websocket_unavailable"; return; }
    clearTimer();
    lifecycle = "connecting";
    if (!replacement) subscriptions = [];
    const candidate = new WebSocketImpl(url);
    if (replacement) pendingSocket = candidate;
    else socket = candidate;
    candidate.onmessage = async message => {
      if (myGeneration !== generation || (candidate !== socket && candidate !== pendingSocket)) return;
      lastMessageAt = now();
      try { onSessionActivity(); } catch {}
      let payload;
      try { payload = JSON.parse(String(message.data || "")); } catch { return; }
      const metadata = payload?.metadata || {};
      if (remember(metadata.message_id)) { counters.duplicates += 1; return; }
      if (metadata.message_type === "session_welcome") {
        const session = payload?.payload?.session || {};
        sessionId = String(session.id || "").slice(0, 160);
        keepaliveTimeoutMs = Math.max(10000, Math.min(120000, Number(session.keepalive_timeout_seconds || 10) * 1000));
        counters.connections += 1;
        scheduleWatchdog(myGeneration);
        if (replacement) {
          const previous = socket;
          socket = candidate;
          pendingSocket = null;
          lifecycle = "connected";
          reconnectAttempts = 0;
          lastError = "";
          try { previous?.close(); } catch {}
          return;
        }
        try { await subscribeAll(sessionId, myGeneration); } catch (error) { lastError = String(error?.message || "twitch_eventsub_subscription_failed").slice(0, 120); try { candidate.close(); } catch {} }
        return;
      }
      if (candidate !== socket) return;
      if (metadata.message_type === "session_keepalive") { scheduleWatchdog(myGeneration); return; }
      if (metadata.message_type === "session_reconnect") {
        const reconnectUrl = safeUrl(payload?.payload?.session?.reconnect_url);
        if (reconnectUrl && !pendingSocket) { counters.reconnects += 1; connect(reconnectUrl, myGeneration, true); }
        return;
      }
      if (metadata.message_type === "revocation") { lastError = "twitch_eventsub_subscription_revoked"; return; }
      if (metadata.message_type === "notification") dispatch(payload?.payload?.subscription?.type, payload?.payload?.event || {});
    };
    candidate.onerror = () => { lastError = "twitch_eventsub_socket_error"; };
    candidate.onclose = () => {
      if (candidate === pendingSocket) { pendingSocket = null; return; }
      if (candidate !== socket) return;
      socket = null;
      subscriptions = [];
      clearTimer();
      scheduleReconnect(myGeneration);
    };
  }
  function start() {
    if (desired) return snapshot();
    desired = true;
    generation += 1;
    connect(EVENTSUB_URL, generation);
    return snapshot();
  }
  function stop() {
    desired = false;
    generation += 1;
    clearTimer();
    const current = socket;
    const pending = pendingSocket;
    socket = null;
    pendingSocket = null;
    subscriptions = [];
    sessionId = "";
    lifecycle = "stopped";
    try { current?.close(); } catch {}
    try { pending?.close(); } catch {}
    return snapshot();
  }

  function restart() {
    stop();
    return start();
  }

  return Object.freeze({ restart, start, stop, status: snapshot });
}

module.exports = createTwitchEventSubMonitor;
module.exports.SEEN_MESSAGE_TTL_MS = SEEN_MESSAGE_TTL_MS;
