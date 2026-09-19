const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const createLayout = require('../src/domains/fixtures/lighting-layout.service');

test('lighting layout persists bounded coordinates and resolves spatial offsets', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ravelink-layout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { storePath: path.join(root, 'layout.json'), fixtureRegistry: { getFixtures: () => [{ id: 'left' }, { id: 'right' }] } };
  const layout = createLayout(options);
  const saved = layout.save({ revision: 0, room: { name: 'Studio', width: 5, depth: 4 }, placements: {
    left: { x: .1, y: .2, z: .3, kind: 'strip', rotation: 90 }, right: { x: .9, y: .9, z: .7 }, unknown: { x: .5, y: .5 }
  } });
  assert.equal(saved.ok, true);
  assert.deepEqual(Object.keys(saved.placements), ['left', 'right']);
  assert.equal(layout.spatialOffset('left', 'sweep'), .1);
  assert.ok(layout.spatialOffset('right', 'ripple') > layout.spatialOffset('left', 'ripple'));
  const restored = createLayout(options).snapshot();
  assert.equal(restored.room.name, 'Studio');
  assert.equal(restored.placements.left.rotation, 90);
});
