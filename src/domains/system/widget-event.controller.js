// [TITLE] Module: domains/system/widget-event.controller.js
// [TITLE] Purpose: server-owned StreamElements light widget event decisions

const { levenshteinDistance, normalizeLookupToken } = require("../../shared/fuzzy/fuzzy-text");
const { youtubeVideoId } = require("../../shared/media/youtube-reference");
const MAX_DEDUPE_ENTRIES = 1024;

function createSystemWidgetEventController(deps = {}) {
  const {
    colorApply = async () => ({ status: 503, body: { ok: false, error: "color_apply_unavailable" } }),
    teachColor = async () => ({ status: 503, body: { ok: false, error: "teach_color_unavailable" } }),
    submitSongRequest = async () => ({ ok: false, error: "song_request_unavailable" }),
    settleRedemption = null,
    now = () => Date.now(),
    dedupeStore = new Map(),
    getTwitchIntakeMode = () => "streamelements"
  } = deps;
  const counters = {
    received: 0,
    ready: 0,
    irrelevant: 0,
    duplicates: 0,
    handled: 0,
    failed: 0,
    color: 0,
    teach: 0,
    song_request: 0,
    rejected: 0,
    rateLimited: 0,
    dedupeEvictions: 0,
    settlementAttempted: 0,
    settlementSucceeded: 0,
    settlementFailed: 0,
    settlementUnavailable: 0,
    transportRejected: 0
  };
  let inFlight = 0;
  let peakInFlight = 0;

  function asString(value) {
    return String(value == null ? "" : value).trim();
  }

  function normalizeToken(value) {
    return asString(value).toLowerCase();
  }

  function safeObject(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function getByPath(source, path) {
    const parts = String(path || "").split(".").filter(Boolean);
    let cur = source;
    for (const part of parts) {
      if (!cur || typeof cur !== "object") return undefined;
      cur = cur[part];
    }
    return cur;
  }

  function pickFirstString(source, paths) {
    for (const path of paths) {
      const value = asString(getByPath(source, path));
      if (value) return value;
    }
    return "";
  }

  function normalizeRewardKey(value) {
    return normalizeLookupToken(value);
  }

  function rewardTokensMatch(candidateRaw, configuredRaw) {
    const candidate = normalizeToken(candidateRaw);
    const configured = normalizeToken(configuredRaw);
    if (!candidate || !configured) return false;
    if (candidate === configured) return true;
    const compactCandidate = normalizeRewardKey(candidate);
    const compactConfigured = normalizeRewardKey(configured);
    if (compactCandidate && compactConfigured && compactCandidate === compactConfigured) return true;
    const idLike = /^[a-f0-9-]{16,}$/i.test(configured);
    if (idLike) return false;
    if (compactCandidate.length < 5 || compactConfigured.length < 5) return false;
    const distance = levenshteinDistance(compactCandidate, compactConfigured);
    const longest = Math.max(compactCandidate.length, compactConfigured.length);
    const similarity = longest > 0 ? (1 - (distance / longest)) : 0;
    return distance <= 2 && similarity >= 0.78;
  }

  function normalizeWidgetConfig(payload = {}) {
    const source = payload.widgetConfig && typeof payload.widgetConfig === "object"
      ? payload.widgetConfig
      : payload;
    return {
      colorRewardId: asString(source.colorRewardId),
      teachRewardId: asString(source.teachRewardId),
      songRewardId: asString(source.songRewardId)
    };
  }

  function unwrapEventEnvelope(payload = {}) {
    if (payload.eventEnvelope && typeof payload.eventEnvelope === "object") return payload.eventEnvelope;
    if (payload.envelope && typeof payload.envelope === "object") return payload.envelope;
    return payload;
  }

  function parseRedemptionEnvelope(eventEnvelope) {
    const root = safeObject(eventEnvelope);
    const detail = safeObject(root.detail);
    const event = safeObject(detail.event || root.event);
    const eventData = safeObject(event.data || detail.eventData || detail.data || root.eventData || root.data);
    const redemption = safeObject(event.redemption || eventData.redemption || (Object.keys(eventData).length ? eventData : event));
    const reward = safeObject(redemption.reward || eventData.reward || event.reward || {});
    const source = { root, detail, event, eventData, redemption, reward };

    return {
      rewardId: pickFirstString(source, [
        "eventData.tags.custom-reward-id",
        "eventData.tags.customRewardId",
        "event.tags.custom-reward-id",
        "event.tags.customRewardId",
        "event.item.reward.id",
        "eventData.item.reward.id",
        "detail.event.item.reward.id",
        "detail.event.data.item.reward.id",
        "reward.id",
        "redemption.reward.id",
        "eventData.redemption.reward.id",
        "eventData.reward.id",
        "eventData.rewardId",
        "redemption.rewardId",
        "event.reward.id",
        "event.rewardId",
        "root.reward.id",
        "root.reward.rewardId"
      ]),
      redemptionId: pickFirstString(source, [
        "event.item.id",
        "eventData.item.id",
        "detail.event.item.id",
        "detail.event.data.item.id",
        "eventData.redemption.id",
        "eventData.redemptionId",
        "redemption.id",
        "redemption.redemptionId",
        "event.redemption.id",
        "event.id",
        "event.redemptionId",
        "eventData.id",
        "eventData.tags.id",
        "event.tags.id",
        "root.reward.redemptionId",
        "root.reward.redemption_id"
      ]),
      broadcasterId: pickFirstString(source, [
        "eventData.broadcaster_user_id",
        "eventData.redemption.broadcaster_id",
        "eventData.broadcaster_id",
        "redemption.broadcaster_user_id",
        "redemption.broadcaster_id",
        "event.broadcaster_user_id",
        "event.redemption.broadcaster_id",
        "event.channelId",
        "eventData.channelId",
        "detail.event.channelId",
        "eventData.tags.room-id",
        "event.tags.room-id",
        "root.channel.broadcasterId",
        "root.channel.id",
        "root.broadcasterId"
      ]),
      userInput: pickFirstString(source, [
        "event.item.user_input",
        "event.item.userInput",
        "event.item.message",
        "event.item.text",
        "event.item.input",
        "eventData.item.user_input",
        "eventData.item.userInput",
        "eventData.item.message",
        "eventData.item.text",
        "eventData.item.input",
        "detail.event.item.user_input",
        "detail.event.item.userInput",
        "detail.event.item.message",
        "detail.event.item.text",
        "detail.event.item.input",
        "detail.event.data.item.user_input",
        "detail.event.data.item.userInput",
        "detail.event.data.item.message",
        "detail.event.data.item.text",
        "detail.event.data.item.input",
        "eventData.redemption.user_input",
        "eventData.redemption.userInput",
        "redemption.text",
        "redemption.message",
        "redemption.input",
        "redemption.user_input",
        "redemption.userInput",
        "event.user_input",
        "event.userInput",
        "event.input",
        "event.message",
        "event.text",
        "event.value1",
        "event.value",
        "root.reward.input",
        "root.reward.userInput",
        "root.reward.text"
      ]),
      userName: pickFirstString(source, [
        "eventData.redemption.user_name",
        "eventData.redemption.user_login",
        "eventData.user_name",
        "eventData.display_name",
        "eventData.displayName",
        "eventData.username",
        "eventData.nick",
        "redemption.user_name",
        "redemption.user_login",
        "event.redemption.user_name",
        "event.displayName",
        "event.username",
        "event.user_name",
        "event.nick",
        "root.user.display",
        "root.user.login",
        "root.user.name"
      ]),
      userId: pickFirstString(source, [
        "eventData.redemption.user_id",
        "eventData.user_id",
        "redemption.user_id",
        "redemption.userId",
        "event.user_id",
        "event.userId",
        "eventData.tags.user-id",
        "event.tags.user-id",
        "root.user.id"
      ]),
      userRole: pickFirstString(source, [
        "event.requester_role",
        "event.requesterRole",
        "eventData.requester_role",
        "eventData.requesterRole"
      ]),
      rewardName: pickFirstString(source, [
        "reward.title",
        "reward.name",
        "eventData.reward.title",
        "eventData.reward.name",
        "event.reward.title",
        "event.reward.name",
        "eventData.tags.custom-reward-title",
        "eventData.tags.customRewardTitle",
        "event.tags.custom-reward-title",
        "event.tags.customRewardTitle",
        "root.reward.name",
        "root.reward.title"
      ]),
      listener: normalizeToken(detail.listener || event.listener || root.listener)
    };
  }

  function buildRewardDedupeKey(meta) {
    const rewardId = normalizeToken(meta.rewardId || meta.rewardName || "");
    const redemptionId = normalizeToken(meta.redemptionId || "");
    if (rewardId && redemptionId) return `rw:${rewardId}:${redemptionId}`;
    const userName = normalizeToken(meta.userName || "");
    const userInput = normalizeToken(meta.userInput || "");
    if (rewardId && userName && userInput) return `rw:${rewardId}:user:${userName}:text:${userInput}`;
    return "";
  }

  function wasRewardSeenRecently(meta, windowMs = 12000) {
    const key = buildRewardDedupeKey(meta);
    if (!key) return false;
    const nowMs = Number(now());
    for (const [existingKey, expiresAt] of dedupeStore.entries()) {
      if (Number(expiresAt || 0) <= nowMs) dedupeStore.delete(existingKey);
    }
    const prev = Number(dedupeStore.get(key) || 0);
    if (prev > nowMs) return true;
    while (dedupeStore.size >= MAX_DEDUPE_ENTRIES) {
      const oldest = dedupeStore.keys().next().value;
      if (oldest === undefined) break;
      dedupeStore.delete(oldest);
      counters.dedupeEvictions += 1;
    }
    dedupeStore.set(key, nowMs + Math.max(2000, Number(windowMs || 12000)));
    return false;
  }

  function resolveRewardAction(meta, config) {
    const rewardCandidates = [meta.rewardId, meta.rewardName].map(asString).filter(Boolean);
    if (!rewardCandidates.length) return "";
    const matchAny = configured => rewardCandidates.some(candidate => rewardTokensMatch(candidate, configured));
    if (matchAny(config.colorRewardId)) return "color";
    if (matchAny(config.teachRewardId)) return "teach";
    if (config.songRewardId && normalizeToken(meta.rewardId) === normalizeToken(config.songRewardId)) return "song_request";
    return "";
  }

  function resultBody(result) {
    return safeObject(result?.body || result?.data || result?.value || {});
  }

  function resultOk(result) {
    const body = resultBody(result);
    return result && result.ok !== false && Number(result.status || 200) >= 200 && Number(result.status || 200) < 300 && body.ok !== false;
  }

  function resolveBridgeFailureMessage(result) {
    const body = resultBody(result);
    return asString(body.detail || body.error || body.reason || body.message || result?.error?.code || result?.error || result?.text || "request failed") || "request failed";
  }

  async function executeReward(meta, config, action, transport) {
    if (action === "color") return await colorApply({ text: meta.userInput, userInput: meta.userInput });
    if (action === "teach") return await teachColor({ text: meta.userInput, userInput: meta.userInput });
    const videoId = youtubeVideoId(meta.userInput);
    const requesterId = asString(meta.userId || meta.userName);
    if (!meta.redemptionId || !requesterId) return { status: 400, body: { ok: false, error: "redemption_identity_incomplete", refundRecommended: true } };
    return submitSongRequest({
      requestId: meta.redemptionId,
      requesterId,
      requesterName: meta.userName,
      requesterRole: ["vip", "moderator"].includes(meta.userRole) ? meta.userRole : "viewer",
      notifyChat: transport === "native",
      query: meta.userInput,
      ...(videoId ? { candidate: { provider: "youtube", providerItemId: videoId, title: meta.userInput, artists: [], durationMs: 0 } } : {})
    });
  }

  async function settle(meta, desiredStatus, reason, transport) {
    if (transport !== "native") {
      return { attempted: false, ok: true, status: "NOT_APPLICABLE", desiredStatus, reason: "transport_conveyor_only" };
    }
    const identityComplete = Boolean(meta.redemptionId && meta.rewardId);
    if (typeof settleRedemption !== "function" || !identityComplete) {
      counters.settlementUnavailable += 1;
      return {
        attempted: false,
        ok: false,
        status: "UNSETTLED",
        desiredStatus,
        reason: identityComplete ? "twitch_settlement_unavailable" : "redemption_identity_incomplete"
      };
    }
    counters.settlementAttempted += 1;
    try {
      const result = await settleRedemption({
        redemptionId: meta.redemptionId,
        rewardId: meta.rewardId,
        broadcasterId: meta.broadcasterId,
        status: desiredStatus,
        reason: asString(reason || (desiredStatus === "FULFILLED" ? "action_succeeded" : "action_failed")).slice(0, 80)
      });
      if (result?.ok === true && result.status === desiredStatus) {
        counters.settlementSucceeded += 1;
        return { attempted: true, ok: true, status: desiredStatus, desiredStatus, refunded: result.refunded === true };
      }
      counters.settlementFailed += 1;
      return { attempted: true, ok: false, status: "UNSETTLED", desiredStatus, reason: asString(result?.error || "twitch_settlement_failed").slice(0, 80) };
    } catch (error) {
      counters.settlementFailed += 1;
      return { attempted: true, ok: false, status: "UNSETTLED", desiredStatus, reason: asString(error?.code || error?.message || "twitch_settlement_failed").slice(0, 80) };
    }
  }

  async function processWidgetEvent(payload = {}) {
    const transport = payload.transport === "native" ? "native" : "streamelements";
    const activeTransport = getTwitchIntakeMode() === "native" ? "native" : "streamelements";
    if (transport !== activeTransport) {
      counters.transportRejected += 1;
      return {
        status: 200,
        body: { ok: true, handled: false, reason: "intake_transport_disabled", activeTransport, actions: [] }
      };
    }
    const config = normalizeWidgetConfig(payload);
    const eventEnvelope = unwrapEventEnvelope(payload);
    const meta = parseRedemptionEnvelope(eventEnvelope);
    if (meta.listener === "ravelink-widget-ready") counters.ready += 1;
    const action = resolveRewardAction(meta, config);
    if (!action) {
      counters.irrelevant += 1;
      return {
        status: 200,
        body: { ok: true, handled: false, reason: "reward_not_configured", actions: [] }
      };
    }
    if (wasRewardSeenRecently(meta, 12000)) {
      counters.duplicates += 1;
      return {
        status: 200,
        body: { ok: true, handled: true, duplicate: true, action, actions: [] }
      };
    }

    const bridgeResult = await executeReward(meta, config, action, transport);
    const body = resultBody(bridgeResult);
    const refundRecommended = body.refundRecommended === true;
    const bridgeOk = resultOk(bridgeResult) && !refundRecommended;
    counters.handled += 1;
    counters[action] += 1;
    if (!bridgeOk) counters.failed += 1;
    const desiredStatus = bridgeOk ? "FULFILLED" : "CANCELED";
    const settlement = await settle(meta, desiredStatus, bridgeOk ? "action_succeeded" : resolveBridgeFailureMessage(bridgeResult), transport);

    return {
      status: 200,
      body: {
        ok: true,
        handled: true,
        action,
        reward: meta,
        status: settlement.status,
        desiredStatus,
        settlement,
        degraded: !settlement.ok,
        degradedCapabilities: settlement.ok ? [] : ["twitch.redemptions.v1"],
        result: body,
        actions: []
      }
    };
  }

  async function handleWidgetEvent(payload = {}) {
    counters.received += 1;
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    try {
      return await processWidgetEvent(payload);
    } finally {
      inFlight = Math.max(0, inFlight - 1);
    }
  }

  function getDiagnostics() {
    return {
      ok: true,
      owner: "core.widget",
      inFlight,
      peakInFlight,
      dedupeEntries: dedupeStore.size,
      maximumDedupeEntries: MAX_DEDUPE_ENTRIES,
      counters: { ...counters }
    };
  }

  function recordRejected(reason = "rejected") {
    counters.rejected += 1;
    if (reason === "rate_limited") counters.rateLimited += 1;
  }

  return {
    handleWidgetEvent,
    getDiagnostics,
    recordRejected,
    parseRedemptionEnvelope,
    normalizeWidgetConfig,
    resolveRewardAction
  };
}

module.exports = {
  createSystemWidgetEventController,
  MAX_DEDUPE_ENTRIES
};
