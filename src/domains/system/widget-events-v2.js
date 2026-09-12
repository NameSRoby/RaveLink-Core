// [TITLE] Module: domains/system/widget-events-v2.js
// [TITLE] Purpose: bounded compatibility and disposition contract for shared widget intake

const CONTRACT = "widget.events.v2";
const MAX_BYTES = 56 * 1024;
const MAX_DEPTH = 16;
const MAX_NODES = 2048;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const V2_KEYS = new Set(["contract", "source", "eventEnvelope", "widgetConfig", "target"]);
const V2_CONFIG_KEYS = new Set(["colorRewardId", "teachRewardId", "songRewardId"]);
const TARGET_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const DISPOSITIONS = Object.freeze({
  HANDLED: "handled",
  IRRELEVANT: "irrelevant",
  DUPLICATE: "duplicate",
  DEGRADED: "degraded",
  REJECTED: "rejected",
  RATE_LIMITED: "rate_limited"
});

function inspectTree(value) {
  let nodes = 0;
  const stack = [{ value, depth: 0 }];
  while (stack.length) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > MAX_NODES) return { ok: false, error: "widget_event_too_complex" };
    if (current.depth > MAX_DEPTH) return { ok: false, error: "widget_event_too_deep" };
    if (!current.value || typeof current.value !== "object") continue;
    for (const key of Object.keys(current.value)) {
      if (FORBIDDEN_KEYS.has(key)) return { ok: false, error: "widget_event_forbidden_key" };
      stack.push({ value: current.value[key], depth: current.depth + 1 });
    }
  }
  return { ok: true, nodes };
}

function validateWidgetEventRequest(payload = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "widget_event_object_required" };
  }
  const contract = String(payload.contract || "").trim();
  if (contract && contract !== CONTRACT) return { ok: false, error: "widget_event_contract_unsupported" };
  if (contract) {
    if (Object.keys(payload).some(key => !V2_KEYS.has(key))) return { ok: false, error: "widget_event_unknown_field" };
    const widgetConfig = payload.widgetConfig;
    if (widgetConfig !== undefined && (!widgetConfig || typeof widgetConfig !== "object" || Array.isArray(widgetConfig))) {
      return { ok: false, error: "widget_event_config_invalid" };
    }
    if (widgetConfig && Object.keys(widgetConfig).some(key => !V2_CONFIG_KEYS.has(key))) {
      return { ok: false, error: "widget_event_config_unknown_field" };
    }
    for (const key of V2_CONFIG_KEYS) {
      if (widgetConfig?.[key] !== undefined && (typeof widgetConfig[key] !== "string" || widgetConfig[key].length > 512)) {
        return { ok: false, error: "widget_event_config_value_invalid" };
      }
    }
    if (payload.target !== undefined && (typeof payload.target !== "string" || !TARGET_RE.test(payload.target))) {
      return { ok: false, error: "widget_event_target_invalid" };
    }
  }
  const source = String(payload.source || "streamelements").trim().toLowerCase();
  if (source !== "streamelements") return { ok: false, error: "widget_event_source_unsupported" };
  if (!payload.eventEnvelope || typeof payload.eventEnvelope !== "object" || Array.isArray(payload.eventEnvelope)) {
    return { ok: false, error: "widget_event_envelope_required" };
  }
  let bytes = 0;
  try { bytes = Buffer.byteLength(JSON.stringify(payload), "utf8"); } catch { return { ok: false, error: "widget_event_not_serializable" }; }
  if (bytes > MAX_BYTES) return { ok: false, error: "widget_event_too_large" };
  const tree = inspectTree(payload);
  if (!tree.ok) return tree;
  return {
    ok: true,
    value: { ...payload, contract: CONTRACT, source: "streamelements" },
    legacy: !contract,
    bytes,
    nodes: tree.nodes
  };
}

function withDisposition(body = {}) {
  const source = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  let disposition = DISPOSITIONS.HANDLED;
  if (source.duplicate === true) disposition = DISPOSITIONS.DUPLICATE;
  else if (source.handled === false) disposition = DISPOSITIONS.IRRELEVANT;
  else if (source.ok === false || source.status === "CANCELED" || source.degraded === true) disposition = DISPOSITIONS.DEGRADED;
  return { ...source, contract: CONTRACT, disposition };
}

module.exports = { CONTRACT, DISPOSITIONS, MAX_BYTES, MAX_DEPTH, MAX_NODES, validateWidgetEventRequest, withDisposition };
