// [TITLE] Module: domains/twitch/color-command.service.js
// [TITLE] Purpose: parse and route Twitch color commands to Hue, WiZ, and alpha Govee fixtures

module.exports = function createColorCommandService(options = {}) {
  const { twitchColorConfig, fixtureRegistry, directiveService, hueBridge, wizBridge, goveeBridge } = options;
  if (!twitchColorConfig || !fixtureRegistry || !directiveService?.parseTwitchColorDirective) throw new Error("createColorCommandService requires color config, fixtures, and directive service");

  function listFixtures(brand = "", zone = "") { return fixtureRegistry.listTwitchBy(brand, zone); }
  function fixtureById(id) { return listFixtures().find(row => String(row.id) === String(id)) || null; }
  function normalizeDelivery(value, targetCount) {
    return value && typeof value === "object"
      ? { sent: Math.max(0, Number(value.sent || 0)), failed: Math.max(0, Number(value.failed || 0)), dryRun: value.dryRun === true, ...(value.command ? { command: structuredClone(value.command) } : {}) }
      : { sent: targetCount, failed: 0 };
  }
  function autoTarget(config) {
    const fallback = twitchColorConfig.parseColorTarget(config.defaultTarget, "hue");
    if (config.autoDefaultTarget === false || fallback === "both") return fallback;
    const fixtures = listFixtures();
    const available = new Set(fixtures.map(row => String(row.brand).toLowerCase()));
    if (available.has(fallback)) return fallback;
    return ["hue", "wiz", "govee"].find(brand => available.has(brand)) || fallback;
  }
  async function applyColorText(rawText, requestOptions = {}) {
    const direct = requestOptions.mode === "direct";
    const route = !direct ? options.twitchLightRouting?.resolve(rawText) : null;
    if (route?.error) return { ok: false, error: route.error };
    const selection = route?.managed ? route.fixtureIds : requestOptions.fixtureIds;
    if (selection !== undefined && !route?.managed && (!direct || !Array.isArray(selection) || !selection.length || selection.length > 64 || selection.some(id => typeof id !== "string" || !id || id.length > 256))) return { ok: false, error: "invalid_fixture_selection" };
    const selectedIds = selection === undefined ? null : new Set(selection);
    const deliveries = [];
    const activeFixtures = (brand = "", zone = "") => direct
      ? fixtureRegistry.listEngineBy(brand, zone).filter(row => !selectedIds || selectedIds.has(row.id))
      : listFixtures(brand, zone).filter(row => !selectedIds || selectedIds.has(row.id));
    const activeFixtureById = id => activeFixtures().find(row => String(row.id) === String(id)) || null;
    const config = twitchColorConfig.getSnapshot();
    const prefixed = route?.managed ? { text: route.text, prefix: route.prefix, target: 'both', fixtureId: '' } : twitchColorConfig.splitPrefixedColorText(rawText, config.prefixes, config.fixturePrefixes);
    const requestedFixtureId = String(requestOptions.fixtureId || (!requestOptions.targetExplicit ? prefixed.fixtureId : "") || "").trim();
    const fixed = requestedFixtureId ? activeFixtureById(requestedFixtureId) : null;
    const fallback = direct ? "both" : autoTarget(config);
    const target = requestOptions.targetExplicit
      ? twitchColorConfig.parseColorTarget(requestOptions.target, fallback)
      : twitchColorConfig.parseColorTarget(fixed?.brand || prefixed.target || fallback, fallback);
    const text = String(prefixed.text || "").trim();
    if (!text) return { ok: false, target, error: "missing color text" };
    if (requestedFixtureId && !fixed) return { ok: false, target: null, fixtureTargetId: requestedFixtureId, error: direct ? "fixture target not found or disabled" : "fixture prefix target not found or not twitch-enabled" };
    const directive = directiveService.parseTwitchColorDirective(text);
    if (!directive.ok) return { ok: false, target, error: directive.error || "invalid color text" };
    const result = { ok: true, target, usedPrefix: prefixed.prefix || null, fixtureTargetId: fixed?.id || null, hueZones: [], wizZones: [], goveeZones: [], hueTargets: 0, wizTargets: 0, goveeTargets: 0, hueDelivery: { sent: 0, failed: 0 }, wizDelivery: { sent: 0, failed: 0 }, goveeDelivery: { sent: 0, failed: 0, alpha: true }, directiveType: directive.type, colorMatch: directive.matchedName || "", fuzzy: directive.fuzzy || null };
    Object.assign(result, { preview: requestOptions.preview === true, targets: [], modifiers: directive.modifiers || {}, hex: directive.hex || '', baseHex: directive.baseHex || '', brightnessPercent: directive.brightnessPercent, ruleIds: route?.ruleIds || [] });

    if (target === "hue" || target === "both") {
      result.hueZones = fixed ? [fixed.zone || "hue"] : fixtureRegistry.parseZoneList(route?.managed ? 'all' : requestOptions.hueZone || requestOptions.zone || (direct ? "all" : fixtureRegistry.resolveZone("TWITCH_HUE") || "hue"), direct ? "all" : "hue");
      const targets = fixed ? (fixed.brand === "hue" ? [fixed] : []) : (() => { const rows = new Map(); for (const zone of result.hueZones) for (const fixture of activeFixtures("hue", zone)) rows.set(fixture.id, fixture); return [...rows.values()]; })();
      result.hueTargets = targets.length;
      result.targets.push(...targets.map(row => row.id));
      if (targets.length && !requestOptions.preview) {
        deliveries.push((async () => {
          try { result.hueDelivery = typeof hueBridge?.sendState === "function" ? normalizeDelivery(await hueBridge.sendState(targets, directive.hueState), targets.length) : { sent: 0, failed: targets.length }; }
        catch { result.hueDelivery = { sent: 0, failed: targets.length }; }
        })());
      }
    }
    if (target === "wiz" || target === "both") {
      result.wizZones = fixed ? [fixed.zone || "wiz"] : fixtureRegistry.parseZoneList(route?.managed ? 'all' : requestOptions.wizZone || requestOptions.zone || (direct ? "all" : fixtureRegistry.resolveZone("TWITCH_WIZ") || "wiz"), direct ? "all" : "wiz");
      const targets = fixed ? (fixed.brand === "wiz" ? [fixed] : []) : (() => { const rows = new Map(); for (const zone of result.wizZones) for (const fixture of activeFixtures("wiz", zone)) rows.set(fixture.id, fixture); return [...rows.values()]; })();
      result.wizTargets = targets.length;
      result.targets.push(...targets.map(row => row.id));
      if (targets.length && !requestOptions.preview) {
        deliveries.push((async () => {
          try { result.wizDelivery = typeof wizBridge?.sendState === "function" ? normalizeDelivery(await wizBridge.sendState(targets, directive.wizState), targets.length) : { sent: 0, failed: targets.length }; }
        catch { result.wizDelivery = { sent: 0, failed: targets.length }; }
        })());
      }
    }
    if (target === "govee" || target === "both") {
      result.goveeZones = fixed ? [fixed.zone || "govee"] : fixtureRegistry.parseZoneList(route?.managed ? "all" : requestOptions.goveeZone || requestOptions.zone || (direct ? "all" : fixtureRegistry.resolveZone("TWITCH_GOVEE") || "govee"), direct ? "all" : "govee");
      const targets = fixed ? (fixed.brand === "govee" ? [fixed] : []) : (() => { const rows = new Map(); for (const zone of result.goveeZones) for (const fixture of activeFixtures("govee", zone)) rows.set(fixture.id, fixture); return [...rows.values()]; })();
      result.goveeTargets = targets.length;
      result.targets.push(...targets.map(row => row.id));
      if (targets.length && !requestOptions.preview) deliveries.push((async () => {
        try { result.goveeDelivery = { ...normalizeDelivery(await goveeBridge.sendState(targets, directive.wizState), targets.length), alpha: true }; }
        catch { result.goveeDelivery = { sent: 0, failed: targets.length, alpha: true }; }
      })());
    }
    await Promise.all(deliveries);
    result.skippedTargets = selectedIds ? Math.max(0, selectedIds.size - result.hueTargets - result.wizTargets - result.goveeTargets) : 0;
    if (result.hueTargets + result.wizTargets + result.goveeTargets === 0) return { ...result, ok: false, error: "no routed fixtures matched" };
    if (requestOptions.preview) return { ...result, sent: 0, failed: 0, partial: result.skippedTargets > 0 };
    result.sent = Number(result.hueDelivery.sent || 0) + Number(result.wizDelivery.sent || 0) + Number(result.goveeDelivery.sent || 0);
    result.failed = Number(result.hueDelivery.failed || 0) + Number(result.wizDelivery.failed || 0) + Number(result.goveeDelivery.failed || 0) + result.skippedTargets;
    result.partial = result.sent > 0 && result.failed > 0;
    return result.sent === 0 && result.failed > 0 ? { ...result, ok: false, error: "hardware_delivery_failed" } : result;
  }
  return Object.freeze({ listColorCommandFixtures: listFixtures, resolveTwitchFixtureById: fixtureById, resolveAutoDefaultColorTarget: autoTarget, applyColorText });
};
