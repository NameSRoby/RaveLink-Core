const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const createLightingLab = require('../src/domains/fixtures/lighting-lab.service');

test('lighting lab persists bounded calibration, exclusions, presets, and session history', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ravelink-light-lab-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixtureRegistry = { getFixtures: () => [{ id: 'desk-hue' }, { id: 'shelf-wiz' }] };
  const service = createLightingLab({ storePath: path.join(root, 'lab.json'), fixtureRegistry });
  const saved = service.save({ revision: 0, excludedFixtureIds: ['desk-hue', 'unknown'], latencyOffsets: { 'desk-hue': -125, 'shelf-wiz': 9999 },
    brightnessLimit: 70, durationSeconds: 30, repeatCount: 3, cooldownSeconds: 10, restorePrevious: true,
    spatialDirection: 'front-rear', spatialOriginFixtureId: 'shelf-wiz', chaseGapMs: 300,
    chaseRoutes: [{ id: 'desk-fx', name: 'Desk FX', prefix: 'deskfx', enabled: true, fixtureIds: ['desk-hue', 'shelf-wiz'] }],
    presets: [{ id: 'neon', name: 'Neon', command: 'fade cyan, purple' }] });
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.excludedFixtureIds, ['desk-hue']);
  assert.deepEqual(saved.latencyOffsets, { 'desk-hue': -125, 'shelf-wiz': 2000 });
  assert.equal(service.isExcluded('desk-hue'), true);
  assert.equal(service.latencyFor('desk-hue'), -125);
  assert.deepEqual(service.resolveChaseRoute('deskfx chase red, blue'), { managed: true, prefix: 'deskfx', text: 'chase red, blue', fixtureIds: ['desk-hue', 'shelf-wiz'], ruleIds: ['chase:desk-fx'], chaseRoute: true });
  assert.equal(service.resolveChaseRoute('deskfx cycle red, blue'), null);
  service.rememberState('desk-hue', 'hue', { on: true, bri: 120 });
  assert.deepEqual(service.previousState('desk-hue'), { brand: 'hue', value: { on: true, bri: 120 } });
  service.record({ source: 'twitch', command: 'red', targets: ['desk-hue'], sent: 1 });
  assert.equal(service.snapshot().history[0].command, 'red');
  assert.equal(service.clearHistory().history.length, 0);
  const reloaded = createLightingLab({ storePath: path.join(root, 'lab.json'), fixtureRegistry }).snapshot();
  assert.equal(reloaded.brightnessLimit, 70);
  assert.equal(reloaded.presets[0].command, 'fade cyan, purple');
  assert.equal(reloaded.chaseRoutes[0].prefix, 'deskfx');
  assert.deepEqual(reloaded.history, []);
});
