const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const createEffects = require('../src/domains/twitch/twitch-light-effects.service');

function setup(t, labOverrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ravelink-effects-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixtures = [
    { id: 'old-hue', name: 'Old Hue', brand: 'hue', twitchEnabled: true },
    { id: 'desk-wiz', name: 'Desk WiZ', brand: 'wiz', twitchEnabled: true },
    { id: 'shelf-govee', name: 'Shelf Govee', brand: 'govee', twitchEnabled: true }
  ];
  const calls = [];
  let at = 1000, interval = null;
  const colors = { red: '#ff0000', green: '#00ff00', blue: '#0000ff', cyan: '#00ffff', purple: '#8000ff', 'deep blue': '#001080' };
  const labSettings = { brightnessLimit: 100, durationSeconds: 0, repeatCount: 0, cooldownSeconds: 0, restorePrevious: false, spatialDirection: 'left-right', spatialOriginFixtureId: '', chaseGapMs: 250, ...labOverrides };
  const service = createEffects({
    storePath: path.join(root, 'effects.json'),
    fixtureRegistry: { listTwitchBy: () => fixtures },
    directiveService: { parseTwitchColorDirective: text => colors[text] ? { ok: true, hex: colors[text] } : { ok: false } },
    adapters: {
      hue: { sendState: async (rows, state) => calls.push({ brand: 'hue', rows, state }), getTelemetry: () => ({ entertainment: { reason: 'entertainment_temporarily_suppressed' } }) },
      wiz: { sendState: async (rows, state) => calls.push({ brand: 'wiz', rows, state }) },
      govee: { sendState: async (rows, state) => calls.push({ brand: 'govee', rows, state }) }
    },
    lightingLab: {
      settings: () => ({ ...labSettings }), isExcluded: id => (labOverrides.excludedFixtureIds || []).includes(id),
      latencyFor: id => Number(labOverrides.latencyOffsets?.[id] || 0), previousState: id => labOverrides.previousStates?.[id] || null,
      record() {}
    },
    now: () => at,
    setInterval: fn => { interval = fn; return { unref() {} }; },
    clearInterval: () => { interval = null; },
    ...(labOverrides.setTimeout ? { setTimeout: labOverrides.setTimeout } : {})
  });
  return { service, calls, fixtures, advance(ms) { at += ms; return service.tick(); }, interval: () => interval };
}

test('dynamic effect parser supports the approved language and does not claim excluded ideas', t => {
  const { service } = setup(t);
  for (const command of ['cycle red, green, blue', 'fade red, blue slow', 'alternate red, blue fast', 'breathe deep blue', 'rainbow', 'wave red, green, blue', 'sweep cyan, purple', 'ripple red, blue', 'chase red, green, blue', 'stop']) {
    const parsed = service.parse(command);
    assert.equal(parsed.matched, true, command);
    assert.equal(parsed.ok, true, command);
  }
  assert.equal(service.parse('sunrise').matched, false);
  assert.equal(service.parse('random warm colors').matched, false);
  assert.equal(service.parse('alternate red, green, blue').ok, false);
  assert.equal(service.parse('alternate red, blue').type, 'cycle');
  assert.equal(service.snapshot().supportedCommands.includes('alternate'), false);
});

test('dynamic routes use all fixtures by default and shared prefixes select subsets', t => {
  const { service } = setup(t);
  const saved = service.save({ revision: 0, enabled: true, fixtureIds: ['old-hue', 'desk-wiz', 'shelf-govee'], prefixes: { 'old-hue': 'desk', 'desk-wiz': 'desk' } });
  assert.equal(saved.ok, true);
  assert.deepEqual(service.resolve('cycle red, blue').fixtureIds, ['old-hue', 'desk-wiz', 'shelf-govee']);
  assert.deepEqual(service.resolve('desk fade red, blue').fixtureIds, ['old-hue', 'desk-wiz']);
  assert.deepEqual(service.resolve('all fade red, blue').fixtureIds, ['old-hue', 'desk-wiz', 'shelf-govee']);
  assert.deepEqual(service.resolve('all stop').fixtureIds, ['old-hue', 'desk-wiz', 'shelf-govee']);
  assert.equal(service.resolve('desk ordinary red').matched, false);
});

test('a static override ends its whole effect session and restores only untargeted siblings', async t => {
  const { service, calls } = setup(t, { previousStates: {
    'old-hue': { brand: 'hue', value: { on: true, bri: 21 } },
    'desk-wiz': { brand: 'wiz', value: { on: true, r: 9, g: 8, b: 7, dimming: 44 } }
  } });
  service.save({ revision: 0, enabled: true, fixtureIds: ['old-hue', 'desk-wiz'] });
  await service.handle('cycle red, blue', { fixtureIds: ['old-hue', 'desk-wiz'] });
  calls.length = 0;
  const result = service.cancelForStaticTargets(['old-hue']);
  assert.equal(result.stopped, 2);
  assert.deepEqual(result.restoredFixtureIds, ['desk-wiz']);
  assert.deepEqual(service.snapshot().activeFixtureIds, []);
  assert.equal(calls.some(row => row.brand === 'hue'), false);
  assert.deepEqual(calls.find(row => row.brand === 'wiz').state, { on: true, r: 9, g: 8, b: 7, dimming: 44 });
});

test('optional animated return performs a settle pulse before restoring the exact prior state', async t => {
  const immediate = handler => { handler(); return { unref() {} }; };
  const { service, calls } = setup(t, { setTimeout: immediate, previousStates: { 'desk-wiz': { brand: 'wiz', value: { on: true, r: 3, g: 4, b: 5, dimming: 55 } } } });
  service.save({ revision: 0, enabled: true, returnEffect: true, fixtureIds: ['desk-wiz'] });
  await service.handle('cycle red, blue', { fixtureIds: ['desk-wiz'] });
  calls.length = 0;
  await service.handle('stop', { fixtureIds: ['desk-wiz'] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls[0].state.dimming, 18);
  assert.deepEqual(calls.at(-1).state, { on: true, r: 3, g: 4, b: 5, dimming: 55 });
});

test('effects require opt-in, intersect the allowlist, and start from one shared clock', async t => {
  const { service, calls, interval, advance } = setup(t);
  assert.equal((await service.handle('cycle red, blue', { fixtureIds: ['old-hue'] })).error, 'dynamic_light_effects_disabled');
  const saved = service.save({ revision: 0, enabled: true, fixtureIds: ['old-hue', 'desk-wiz'] });
  assert.equal(saved.ok, true);
  const result = await service.handle('fade red, blue', { fixtureIds: ['old-hue', 'shelf-govee'] });
  assert.deepEqual(result.targets, ['old-hue']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].brand, 'hue');
  assert.equal(calls[0].state.transitiontime, 0);
  assert.equal(calls[0].state.__forceRest, undefined);
  assert.equal(result.synchronized, true);
  assert.equal(result.startsAt, 1500);
  await advance(500);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].state.transitiontime, 24);
  assert.equal(typeof interval(), 'function');
  const stopped = await service.handle('stop', { fixtureIds: ['old-hue'] });
  assert.equal(stopped.stopped, 1);
  assert.equal(interval(), null);
});

test('starting another effect replaces fixture ownership and static cancellation is scoped', async t => {
  const { service } = setup(t);
  service.save({ revision: 0, enabled: true, fixtureIds: ['old-hue', 'desk-wiz'] });
  await service.handle('cycle red, blue', { fixtureIds: ['old-hue', 'desk-wiz'] });
  await service.handle('breathe green', { fixtureIds: ['desk-wiz'] });
  assert.deepEqual(service.snapshot().activeFixtureIds, ['desk-wiz', 'old-hue']);
  assert.equal(service.cancelFixtureIds(['old-hue']), 1);
  assert.deepEqual(service.snapshot().activeFixtureIds, ['desk-wiz']);
  service.shutdown();
  assert.deepEqual(service.snapshot().activeFixtureIds, []);
});

test('mixed-brand cycle fixtures use the same phase boundaries', async t => {
  const { service, calls, advance } = setup(t);
  service.save({ revision: 0, enabled: true, fixtureIds: ['old-hue', 'desk-wiz', 'shelf-govee'] });
  const result = await service.handle('cycle red, blue', { fixtureIds: ['shelf-govee', 'old-hue', 'desk-wiz'] });
  assert.equal(result.synchronized, true);
  assert.equal(new Set(calls.filter(row => row.brand !== 'hue').map(row => `${row.state.r},${row.state.g},${row.state.b}`)).size, 1);
  assert.equal(calls.some(row => row.brand === 'hue'), true);
  await advance(500);
  calls.length = 0;
  await advance(2400);
  assert.deepEqual(new Set(calls.map(row => row.brand)), new Set(['hue', 'wiz', 'govee']));
  assert.equal(new Set(calls.filter(row => row.brand !== 'hue').map(row => `${row.state.r},${row.state.g},${row.state.b}`)).size, 1);
  assert.equal(calls.find(row => row.brand === 'hue').state.transitiontime, 0);
  service.shutdown();
});

test('mixed-brand hard steps use absolute boundaries without relative cadence beat drift', async t => {
  const { service, calls, advance } = setup(t);
  service.save({ revision: 0, enabled: true, fixtureIds: ['old-hue', 'desk-wiz', 'shelf-govee'] });
  await service.handle('cycle red, blue', { fixtureIds: ['old-hue', 'desk-wiz', 'shelf-govee'] });
  calls.length = 0;
  await advance(500);
  await advance(2399);
  assert.equal(calls.length, 0);
  await advance(1);
  assert.deepEqual(new Set(calls.map(row => row.brand)), new Set(['hue', 'wiz', 'govee']));
  calls.length = 0;
  await advance(2400);
  assert.deepEqual(new Set(calls.map(row => row.brand)), new Set(['hue', 'wiz', 'govee']));
});

test('smooth WiZ sampling catches up to absolute slots instead of drifting from late ticks', async t => {
  const { service, calls, advance } = setup(t);
  service.save({ revision: 0, enabled: true, fixtureIds: ['desk-wiz'] });
  await service.handle('fade red, blue', { fixtureIds: ['desk-wiz'] });
  calls.length = 0;
  await advance(760);
  assert.equal(calls.length, 1);
  await advance(239);
  assert.equal(calls.length, 1);
  await advance(1);
  assert.equal(calls.length, 2);
});

test('lab limits cap brightness, stop duration, restore prior state, and enforce cooldown', async t => {
  const { service, calls, advance } = setup(t, { brightnessLimit: 45, durationSeconds: 1, cooldownSeconds: 2, restorePrevious: true,
    previousStates: { 'old-hue': { brand: 'hue', value: { on: true, bri: 12 } } } });
  service.save({ revision: 0, enabled: true, fixtureIds: ['old-hue'] });
  const started = await service.handle('cycle red, blue', { fixtureIds: ['old-hue'] });
  assert.equal(started.ok, true);
  assert.equal(calls[0].state.bri <= 115, true);
  await advance(1600);
  assert.deepEqual(service.snapshot().activeFixtureIds, []);
  assert.equal(calls.some(row => row.state.bri === 12), true);
  assert.equal((await service.handle('cycle red, blue', { fixtureIds: ['old-hue'] })).error, 'no_effect_enabled_fixtures_matched');
});

test('a negative timing adjustment delays a faster fixture on the shared phase clock', async t => {
  const { service, calls, advance } = setup(t, { latencyOffsets: { 'desk-wiz': -100 } });
  service.save({ revision: 0, enabled: true, fixtureIds: ['old-hue', 'desk-wiz'] });
  await service.handle('cycle red, blue', { fixtureIds: ['old-hue', 'desk-wiz'] });
  await advance(500);
  calls.length = 0;
  await advance(2400);
  assert.deepEqual(calls.map(row => row.brand), ['hue']);
  await advance(100);
  const delayedWiz = calls.find(row => row.brand === 'wiz');
  assert.deepEqual([delayedWiz.state.r, delayedWiz.state.g, delayedWiz.state.b], [0, 0, 255]);
});

test('chase keeps one master clock while applying a deterministic fixture gap', async t => {
  const { service, calls, advance } = setup(t, { chaseGapMs: 250 });
  service.save({ revision: 0, enabled: true, fixtureIds: ['old-hue', 'desk-wiz', 'shelf-govee'] });
  await service.handle('chase red, blue fast', { fixtureIds: ['old-hue', 'desk-wiz', 'shelf-govee'] });
  await advance(500); calls.length = 0;
  await advance(1200);
  const wiz = calls.find(row => row.brand === 'wiz'), govee = calls.find(row => row.brand === 'govee');
  assert.deepEqual([wiz.state.r, wiz.state.g, wiz.state.b], [0, 0, 255]);
  assert.deepEqual([govee.state.r, govee.state.g, govee.state.b], [255, 0, 0]);
});

test('spatial sweep is a brightness pulse while wave remains a full-brightness gradient', async t => {
  const spatialOffsets = { 'desk-wiz': 0.1, 'old-hue': 0.35, 'shelf-govee': 0.7 };
  const first = setup(t);
  // Inject the small public geometry boundary used by the renderer.
  first.service.shutdown();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ravelink-effects-spatial-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixtures = first.fixtures, calls = []; let at = 1000;
  const create = () => createEffects({ storePath: path.join(root, `effects-${Math.random()}.json`), fixtureRegistry: { listTwitchBy: () => fixtures },
    directiveService: { parseTwitchColorDirective: text => ({ ok: true, hex: text === 'red' ? '#ff0000' : '#0000ff' }) },
    adapters: { hue: { sendState: async () => {}, getTelemetry: () => ({ entertainment: {} }) }, wiz: { sendState: async (rows, state) => calls.push({ id: rows[0].id, state }) }, govee: { sendState: async (rows, state) => calls.push({ id: rows[0].id, state }) } },
    lightingLayout: { spatialOffset: id => spatialOffsets[id] }, lightingLab: { settings: () => ({ brightnessLimit: 100, durationSeconds: 0, repeatCount: 0, cooldownSeconds: 0, restorePrevious: false, chaseGapMs: 250 }), isExcluded: () => false, latencyFor: () => 0, previousState: () => null, record() {} },
    now: () => at, setInterval: () => ({ unref() {} }), clearInterval() {} });
  const sweep = create(); sweep.save({ revision: 0, enabled: true, fixtureIds: fixtures.map(row => row.id) }); await sweep.handle('sweep red, blue', { fixtureIds: fixtures.map(row => row.id) });
  const sweepBrightness = calls.filter(row => row.state.dimming).map(row => row.state.dimming); assert.equal(new Set(sweepBrightness).size > 1, true);
  calls.length = 0; const wave = create(); wave.save({ revision: 0, enabled: true, fixtureIds: fixtures.map(row => row.id) }); await wave.handle('wave red, blue', { fixtureIds: fixtures.map(row => row.id) });
  assert.equal(calls.filter(row => row.state.dimming).every(row => row.state.dimming === 100), true);
});
