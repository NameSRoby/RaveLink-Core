const test = require("node:test");
const assert = require("node:assert/strict");

const createColorCommandService = require("../src/domains/twitch/color-command.service");

test("color-command service routes a parsed color to independently enabled fixtures", async () => {
  const calls = [];
  const service = createColorCommandService({
    twitchColorConfig: {
      getSnapshot: () => ({ defaultTarget: "both", autoDefaultTarget: false, prefixes: {}, fixturePrefixes: {} }),
      splitPrefixedColorText: text => ({ text, target: null, fixtureId: null, prefix: null }),
      parseColorTarget: (target, fallback) => ["hue", "wiz", "both"].includes(target) ? target : fallback
    },
    fixtureRegistry: {
      listTwitchBy: (brand, zone) => [{ id: `${brand}-${zone}`, brand, zone }],
      parseZoneList: value => [String(value)],
      resolveZone: key => key === "TWITCH_HUE" ? "desk" : "room"
    },
    directiveService: {
      parseTwitchColorDirective: () => ({
        ok: true,
        target: "both",
        hueState: { on: true, bri: 200, xy: [0.1, 0.2] },
        wizState: { on: true, r: 0, g: 0, b: 255, dimming: 70 }
      })
    },
    hueBridge: { sendState: async fixtures => calls.push(["hue", fixtures[0].id]) },
    wizBridge: { sendState: fixtures => calls.push(["wiz", fixtures[0].id]) }
  });

  const result = await service.applyColorText("blue");
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [["hue", "hue-desk"], ["wiz", "wiz-room"]]);
  assert.equal(typeof service.applyTwitchRaveOffColorProfile, "undefined");
});

test("direct control targets one engine-enabled fixture without requiring Twitch routing", async () => {
  const sent = [];
  const fixture = { id: "private-desk", brand: "wiz", zone: "desk", engineEnabled: true, twitchEnabled: false, ip: "192.168.1.90" };
  const service = createColorCommandService({
    twitchColorConfig: {
      getSnapshot: () => ({ defaultTarget: "hue", autoDefaultTarget: true, prefixes: {}, fixturePrefixes: {} }),
      splitPrefixedColorText: value => ({ text: value, target: null, fixtureId: "", prefix: "" }),
      parseColorTarget: (target, fallback) => ["hue", "wiz", "both"].includes(target) ? target : fallback
    },
    fixtureRegistry: {
      listTwitchBy: () => [],
      listEngineBy: (brand = "", zone = "") => (!brand || brand === "wiz") && (!zone || zone === "all" || zone === "desk") ? [fixture] : [],
      parseZoneList: value => [String(value)],
      resolveZone: () => ""
    },
    directiveService: {
      parseTwitchColorDirective: () => ({ ok: true, type: "color", hueState: {}, wizState: { on: true, r: 10, g: 20, b: 30, dimming: 60 } })
    },
    hueBridge: { sendState: async () => { throw new Error("wrong_adapter"); } },
    wizBridge: { sendState: rows => sent.push(...rows) }
  });
  const result = await service.applyColorText("blue 60%", { mode: "direct", fixtureId: "private-desk" });
  assert.equal(result.ok, true);
  assert.equal(result.fixtureTargetId, "private-desk");
  assert.deepEqual(sent.map(row => row.id), ["private-desk"]);
});

test("direct control reports partial delivery without discarding successful fixtures", async () => {
  const rows = [
    { id: "hue-ok", brand: "hue", zone: "desk" },
    { id: "wiz-offline", brand: "wiz", zone: "desk" }
  ];
  const service = createColorCommandService({
    twitchColorConfig: {
      getSnapshot: () => ({ defaultTarget: "both", autoDefaultTarget: false, prefixes: {}, fixturePrefixes: {} }),
      splitPrefixedColorText: value => ({ text: value, target: null, fixtureId: "", prefix: "" }),
      parseColorTarget: (target, fallback) => ["hue", "wiz", "both"].includes(target) ? target : fallback
    },
    fixtureRegistry: {
      listTwitchBy: () => rows,
      listEngineBy: brand => rows.filter(row => !brand || row.brand === brand),
      parseZoneList: () => ["all"],
      resolveZone: () => ""
    },
    directiveService: { parseTwitchColorDirective: () => ({ ok: true, hueState: {}, wizState: {} }) },
    hueBridge: { sendState: async () => ({ sent: 1, failed: 0 }) },
    wizBridge: { sendState: async () => ({ sent: 0, failed: 1 }) }
  });
  const result = await service.applyColorText("blue", { mode: "direct", target: "both", targetExplicit: true });
  assert.equal(result.ok, true);
  assert.equal(result.sent, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.partial, true);
});

test("direct control routes Govee alpha fixtures through the LAN adapter", async () => {
  const sent = [];
  const fixture = { id: "govee-desk", brand: "govee", zone: "desk", engineEnabled: true, ip: "192.168.1.92" };
  const service = createColorCommandService({
    twitchColorConfig: {
      getSnapshot: () => ({ defaultTarget: "govee", autoDefaultTarget: false, prefixes: { govee: "govee" }, fixturePrefixes: {} }),
      splitPrefixedColorText: value => ({ text: value, target: null, fixtureId: "", prefix: "" }),
      parseColorTarget: (target, fallback) => ["hue", "wiz", "govee", "both"].includes(target) ? target : fallback
    },
    fixtureRegistry: {
      listTwitchBy: () => [],
      listEngineBy: brand => !brand || brand === "govee" ? [fixture] : [],
      parseZoneList: () => ["all"],
      resolveZone: () => ""
    },
    directiveService: { parseTwitchColorDirective: () => ({ ok: true, type: "color", hueState: {}, wizState: { on: true, r: 10, g: 20, b: 30, dimming: 60 } }) },
    goveeBridge: { sendState: async (rows, state) => { sent.push({ rows, state }); return { sent: rows.length, failed: 0 }; } }
  });
  const result = await service.applyColorText("blue 60%", { mode: "direct", target: "govee", targetExplicit: true });
  assert.equal(result.ok, true);
  assert.equal(result.goveeTargets, 1);
  assert.equal(result.goveeDelivery.alpha, true);
  assert.deepEqual(sent[0].rows.map(row => row.id), ["govee-desk"]);
  assert.deepEqual(sent[0].state, { on: true, r: 10, g: 20, b: 30, dimming: 60 });
});

test("a static Twitch color cancels an active effect only after resolving its routed fixtures", async () => {
  const cancelled = [];
  const service = createColorCommandService({
    twitchColorConfig: {
      getSnapshot: () => ({ defaultTarget: "hue", autoDefaultTarget: false, prefixes: {}, fixturePrefixes: {} }),
      splitPrefixedColorText: text => ({ text, target: null, fixtureId: null, prefix: null }),
      parseColorTarget: (target, fallback) => target || fallback
    },
    twitchLightRouting: { resolve: text => ({ managed: true, text, fixtureIds: ['hue-one'], prefix: '', ruleIds: ['active'] }) },
    fixtureRegistry: {
      listTwitchBy: brand => !brand || brand === 'hue' ? [{ id: 'hue-one', brand: 'hue', zone: 'hue' }] : [],
      parseZoneList: () => ['all'], resolveZone: () => 'hue'
    },
    directiveService: { parseTwitchColorDirective: () => ({ ok: true, type: 'color', hueState: { on: true }, wizState: {} }) },
    hueBridge: { sendState: async () => ({ sent: 1, failed: 0 }) },
    twitchLightEffects: {
      handle: async () => ({ matched: false }),
      cancelFixtureIds: ids => cancelled.push(...ids)
    }
  });
  assert.equal((await service.applyColorText('red')).ok, true);
  assert.deepEqual(cancelled, ['hue-one']);
});

test("a prefixed chase route may overlap normal routing and supplies its selected fixtures", async () => {
  let handled;
  const fixtures = [{ id: 'hue-one', brand: 'hue' }, { id: 'wiz-one', brand: 'wiz' }];
  const service = createColorCommandService({
    twitchColorConfig: { getSnapshot: () => ({ defaultTarget: 'both', autoDefaultTarget: false, prefixes: {}, fixturePrefixes: {} }), splitPrefixedColorText: text => ({ text }), parseColorTarget: value => value || 'both' },
    twitchLightRouting: { resolve: () => ({ managed: true, text: 'chase red, blue', fixtureIds: ['hue-one'] }) },
    lightingLab: { resolveChaseRoute: () => ({ managed: true, prefix: 'deskfx', text: 'chase red, blue', fixtureIds: ['hue-one', 'wiz-one'], ruleIds: ['chase:desk'], chaseRoute: true }), isExcluded: () => false },
    fixtureRegistry: { listTwitchBy: () => fixtures, parseZoneList: () => ['all'], resolveZone: () => '' },
    directiveService: { parseTwitchColorDirective: () => ({ ok: false }) },
    twitchLightEffects: { handle: async (text, context) => (handled = { text, context }, { matched: true, ok: true, effect: 'chase', targets: context.fixtureIds }) }
  });
  const result = await service.applyColorText('deskfx chase red, blue');
  assert.deepEqual(result.targets, ['hue-one', 'wiz-one']);
  assert.equal(handled.text, 'chase red, blue');
});

test("dynamic effect routing is resolved before and independently from static fixture assignments", async () => {
  let staticResolved = false, handled;
  const service = createColorCommandService({
    twitchColorConfig: { getSnapshot: () => ({ defaultTarget: 'both', autoDefaultTarget: false, prefixes: {}, fixturePrefixes: {} }), splitPrefixedColorText: text => ({ text }), parseColorTarget: value => value || 'both' },
    twitchLightRouting: { resolve: () => { staticResolved = true; return { managed: true, error: 'no_twitch_assignments_matched' }; } },
    fixtureRegistry: { listTwitchBy: () => [], parseZoneList: () => ['all'], resolveZone: () => '' },
    directiveService: { parseTwitchColorDirective: () => ({ ok: false }) },
    twitchLightEffects: {
      resolve: text => ({ matched: true, text: text.replace(/^fx\s+/, ''), prefix: 'fx', fixtureIds: ['effect-only'] }),
      handle: async (text, context) => (handled = { text, context }, { matched: true, ok: true, effect: 'fade', targets: context.fixtureIds })
    }
  });
  const result = await service.applyColorText('fx fade red, blue');
  assert.deepEqual(result.targets, ['effect-only']);
  assert.equal(staticResolved, false);
  assert.equal(handled.context.prefix, 'fx');
});

test("all static color targets the union of enabled routes and leaves unrouted fixtures untouched", async () => {
  let staticResolved = false;
  const fixtures = [{ id: 'hue-all', brand: 'hue', zone: 'hue' }, { id: 'wiz-all', brand: 'wiz', zone: 'wiz' }, { id: 'unrouted', brand: 'wiz', zone: 'wiz' }];
  const service = createColorCommandService({
    twitchColorConfig: { getSnapshot: () => ({ defaultTarget: 'hue', autoDefaultTarget: false, prefixes: {}, fixturePrefixes: {} }), splitPrefixedColorText: text => ({ text }), parseColorTarget: value => value || 'hue' },
    twitchLightRouting: { resolve: () => { staticResolved = true; return { managed: true, fixtureIds: [] }; }, resolveAll: () => ({ managed: true, fixtureIds: ['hue-all', 'wiz-all'], ruleIds: ['active', 'desk'] }) },
    fixtureRegistry: { listTwitchBy: brand => fixtures.filter(row => !brand || row.brand === brand), parseZoneList: () => ['all'], resolveZone: () => '' },
    directiveService: { parseTwitchColorDirective: text => ({ ok: text === 'red', type: 'color', hex: '#ff0000', hueState: { on: true }, wizState: { on: true, r: 255, g: 0, b: 0 } }) },
    hueBridge: { sendState: async rows => ({ sent: rows.length, failed: 0 }) }, wizBridge: { sendState: async rows => ({ sent: rows.length, failed: 0 }) },
    twitchLightEffects: { resolve: () => ({ matched: false }), cancelForStaticTargets() {} }
  });
  const result = await service.applyColorText('all red');
  assert.equal(staticResolved, false);
  assert.deepEqual(result.targets.sort(), ['hue-all', 'wiz-all']);
  assert.equal(result.sent, 2);
});
