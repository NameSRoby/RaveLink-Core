const test = require("node:test");
const assert = require("node:assert/strict");

const { CONTRACT, MAX_DEPTH, validateWidgetEventRequest, withDisposition } = require("../src/domains/system/widget-events-v2");
const schema = require("../src/domains/system/contracts/widget-events-v2.schema.json");

test("widget.events.v2 accepts bounded v2 and upgrades legacy envelopes", () => {
  const v2 = validateWidgetEventRequest({ contract: CONTRACT, source: "streamelements", eventEnvelope: { detail: { listener: "message" } } });
  assert.equal(v2.ok, true);
  assert.equal(v2.legacy, false);
  assert.equal(schema.properties.contract.const, CONTRACT);
  const legacy = validateWidgetEventRequest({ eventEnvelope: { detail: { listener: "redemption-latest" } } });
  assert.equal(legacy.ok, true);
  assert.equal(legacy.legacy, true);
  assert.equal(legacy.value.contract, CONTRACT);
});

test("widget.events.v2 rejects unsupported, deep, and prototype-sensitive payloads", () => {
  assert.equal(validateWidgetEventRequest({ contract: "widget.events.v9", eventEnvelope: {} }).error, "widget_event_contract_unsupported");
  assert.equal(validateWidgetEventRequest({ source: "unknown", eventEnvelope: {} }).error, "widget_event_source_unsupported");
  assert.equal(validateWidgetEventRequest({ contract: CONTRACT, source: "streamelements", eventEnvelope: {}, surprise: true }).error, "widget_event_unknown_field");
  assert.equal(validateWidgetEventRequest({ contract: CONTRACT, source: "streamelements", eventEnvelope: {}, target: "../mod" }).error, "widget_event_target_invalid");
  assert.equal(validateWidgetEventRequest({ contract: CONTRACT, source: "streamelements", eventEnvelope: {}, widgetConfig: { colorRewardId: 42 } }).error, "widget_event_config_value_invalid");
  assert.equal(validateWidgetEventRequest({ contract: CONTRACT, source: "streamelements", eventEnvelope: {}, widgetConfig: { twitchStatusSyncEnabled: true } }).error, "widget_event_config_unknown_field");
  let deep = {};
  let cursor = deep;
  for (let index = 0; index < MAX_DEPTH + 2; index += 1) cursor = cursor.next = {};
  assert.equal(validateWidgetEventRequest({ eventEnvelope: deep }).error, "widget_event_too_deep");
  const dangerous = JSON.parse('{"eventEnvelope":{},"__proto__":{"polluted":true}}');
  assert.equal(validateWidgetEventRequest(dangerous).error, "widget_event_forbidden_key");
});

test("widget.events.v2 produces stable compatibility dispositions", () => {
  assert.equal(withDisposition({ ok: true, handled: true }).disposition, "handled");
  assert.equal(withDisposition({ ok: true, handled: false }).disposition, "irrelevant");
  assert.equal(withDisposition({ ok: true, duplicate: true }).disposition, "duplicate");
  assert.equal(withDisposition({ ok: true, handled: true, status: "CANCELED" }).disposition, "degraded");
  assert.equal(withDisposition({ ok: true, handled: true, degraded: true }).disposition, "degraded");
});
