// [TITLE] Module: domains/system/widget-template.builder-core.js
// [TITLE] Purpose: generate the minimal server-owned StreamElements event forwarder

function normalizeWidgetPayload(input = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  let baseUrl = String(source.baseUrl || "http://127.0.0.1:5050").trim().slice(0, 2048);
  while (baseUrl.endsWith("/")) baseUrl = baseUrl.slice(0, -1);
  return {
    colorRewardId: String(source.colorRewardId || "").trim().slice(0, 512),
    teachRewardId: String(source.teachRewardId || "").trim().slice(0, 512),
    songRewardId: String(source.songRewardId || "").trim().slice(0, 512),
    baseUrl: baseUrl || "http://127.0.0.1:5050",
    widgetIntakeToken: String(source.widgetIntakeToken || "").trim().slice(0, 512)
  };
}

function buildWidgetTemplateWarnings(input = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const ignoredCredentials = [
    source.twitchClientId,
    source.twitchUserAccessToken,
    source.twitchRefreshToken,
    source.streamElementsBotJwt,
    source.streamElementsBotChannelId
  ].some(value => String(value || "").trim());
  const warnings = ignoredCredentials
    ? [{
      code: "widget_credentials_ignored",
      severity: "warning",
      message: "OAuth and chat credentials are server-owned and were excluded from widget code."
    }]
    : [];
  if (!String(source.widgetIntakeToken || "").trim()) warnings.push({
    code: "widget_intake_token_missing",
    severity: "warning",
    message: "Hosted widget forwarding requires the same scoped intake token configured on the server."
  });
  return warnings;
}

function generateSlimWidgetTemplateScript(config = {}) {
  const safeConfig = normalizeWidgetPayload(config);
  const configJson = JSON.stringify(safeConfig, null, 2);
  return [
    "/* RaveLink StreamElements widget: minimal event forwarder */",
    "const RAVELINK_WIDGET_CONFIG = " + configJson + ";",
    "",
    "(function ravelinkWidgetBootstrap() {",
    "  const CFG = Object.freeze(RAVELINK_WIDGET_CONFIG);",
    "  const rewardIds = new Set([CFG.colorRewardId, CFG.teachRewardId, CFG.songRewardId].filter(Boolean));",
    "  const recent = new Map();",
    "  let inFlight = false;",
    "  const FORWARD_TIMEOUT_MS = 3500;",
    "",
    "  function text(value) { return String(value == null ? \"\" : value).trim(); }",
    "  function object(value) { return value && typeof value === \"object\" && !Array.isArray(value) ? value : {}; }",
    "  function eventParts(envelope) {",
    "    const root = object(envelope);",
    "    const detail = object(root.detail);",
    "    const event = object(detail.event || root.event);",
    "    const data = object(event.data || detail.data || root.data);",
    "    const redemption = object(event.redemption || data.redemption || (Object.keys(data).length ? data : event));",
    "    const item = object(event.item || data.item);",
    "    const reward = object(redemption.reward || item.reward || event.reward || data.reward);",
    "    const tags = object(data.tags || event.tags);",
    "    return { root, detail, event, data, redemption, item, reward, tags };",
    "  }",
    "  function rewardId(envelope) {",
    "    const p = eventParts(envelope);",
    "    return text(p.tags[\"custom-reward-id\"] || p.tags.customRewardId || p.reward.id || p.data.rewardId || p.redemption.rewardId || p.event.rewardId);",
    "  }",
    "  function eventId(envelope) {",
    "    const p = eventParts(envelope);",
    "    return text(p.item.id || p.redemption.id || p.data.redemptionId || p.event.id || p.tags.id);",
    "  }",
    "  function compactEvent(envelope) {",
    "    const p = eventParts(envelope);",
    "    return { detail: { listener: text(p.detail.listener), event: {",
    "      id: eventId(envelope), user_input: text(p.item.user_input || p.redemption.user_input || p.event.user_input || p.data.text),",
    "      user_id: text(p.redemption.user_id || p.event.user_id || p.tags['user-id']), user_name: text(p.redemption.user_name || p.event.user_name || p.data.displayName || p.data.nick),",
    "      broadcaster_user_id: text(p.event.broadcaster_user_id || p.data.broadcaster_user_id || p.tags['room-id']),",
    "      reward: { id: rewardId(envelope), title: text(p.reward.title || p.reward.name || p.tags['custom-reward-title']) }",
    "    } } };",
    "  }",
    "  function isRelevant(envelope) {",
    "    const id = rewardId(envelope);",
    "    if (id) return rewardIds.size === 0 || rewardIds.has(id);",
    "    const listener = text(object(envelope).detail && object(envelope).detail.listener).toLowerCase();",
    "    return rewardIds.size === 0 && listener.includes(\"redemption\");",
    "  }",
    "  function isDuplicate(envelope) {",
    "    const id = eventId(envelope);",
    "    if (!id) return false;",
    "    const now = Date.now();",
    "    for (const [key, at] of recent) if ((now - at) > 15000) recent.delete(key);",
    "    if (recent.has(id)) return true;",
    "    recent.set(id, now);",
    "    while (recent.size > 128) recent.delete(recent.keys().next().value);",
    "    return false;",
    "  }",
    "  function transportResult(ok, status) {",
    "    const code = Number(status || 0);",
    "    let outcome = ok ? \"accepted\" : \"rejected\";",
    "    if (code === 401 || code === 403) outcome = \"authentication_rejected\";",
    "    else if (code === 429) outcome = \"rate_limited\";",
    "    else if (code === 404) outcome = \"contract_unavailable\";",
    "    else if (code >= 500 || code === 0) outcome = \"server_unavailable\";",
    "    return { ok: ok === true, status: code, outcome, terminal: true };",
    "  }",
    "  async function forward(envelope, force) {",
    "    if (inFlight || (!force && !isRelevant(envelope)) || isDuplicate(envelope)) return { ok: true, skipped: true };",
    "    inFlight = true;",
    "    const controller = new AbortController();",
    "    const timeout = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS);",
    "    try {",
    "      const headers = { \"Content-Type\": \"application/json\" };",
    "      if (CFG.widgetIntakeToken) headers.Authorization = \"Bearer \" + CFG.widgetIntakeToken;",
    "      const response = await fetch(CFG.baseUrl + \"/widget/events\", {",
    "        method: \"POST\",",
    "        headers,",
    "        body: JSON.stringify({ contract: \"widget.events.v2\", source: \"streamelements\", eventEnvelope: compactEvent(envelope), widgetConfig: {",
    "          colorRewardId: CFG.colorRewardId, teachRewardId: CFG.teachRewardId, songRewardId: CFG.songRewardId",
    "        } }),",
    "        signal: controller.signal",
    "      });",
    "      return transportResult(response.ok, response.status);",
    "    } catch (error) {",
    "      console.warn(\"[RAVELINK][WIDGET] event forward failed\", text(error && error.message));",
    "      return transportResult(false, 0);",
    "    } finally {",
    "      clearTimeout(timeout);",
    "      inFlight = false;",
    "    }",
    "  }",
    "  function onEventReceived(envelope) { void forward(envelope); }",
    "  window.addEventListener(\"onEventReceived\", onEventReceived);",
    "  window.addEventListener(\"onWidgetLoad\", function () { void forward({ detail: { listener: \"ravelink-widget-ready\", event: { version: 3 } } }, true); });",
    "  window.RaveLinkWidgetRuntime = Object.freeze({ config: CFG, forward, isRelevant });",
    "})();"
  ].join("\n");
}

function generateWidgetTemplate(payload = {}) {
  const active = normalizeWidgetPayload(payload);
  return {
    ok: true,
    script: generateSlimWidgetTemplateScript(active),
    active,
    warnings: buildWidgetTemplateWarnings(payload)
  };
}

module.exports = {
  normalizeWidgetPayload,
  buildWidgetTemplateWarnings,
  generateSlimWidgetTemplateScript,
  generateWidgetTemplate
};
