const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const createServer = require('../src/app/core/create-core-server');

test('Twitch fixture board moves exclusive members and previews request-local descriptors', async t => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'twitch-program-ui-'));
  const { app, services } = createServer({ runtimeDir, dryRun: true });
  const core = services.lightingCore;
  for (const [i, id] of ['left', 'right', 'effect-only'].entries()) core.fixtureRegistry.upsertFixture({ id, name: `Desk ${id}`, brand: 'wiz', ip: `192.0.2.${20 + i}`, twitchEnabled: true, engineEnabled: true });
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await services.lifecycle.stopAll(); await new Promise(resolve => server.close(resolve)); fs.rmSync(runtimeDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.locator('#twitchLightProgram > summary').click();
  await page.locator('#twitchRoutingMode').selectOption('assignments');

  for (const id of ['left', 'right']) {
    await page.locator(`.fixtureChip[data-fixture-id="${id}"]`).click();
    await page.locator('#fixtureDestination').selectOption('active-fixtures');
    await page.locator('#moveSelectedFixture').click();
  }
  assert.equal(await page.locator('[data-drop-zone="active-fixtures"] .fixtureChip').count(), 2);
  await page.locator('#saveTwitchProgram').click();
  await page.locator('#twitchProgramNotice').filter({ hasText: 'Fixture assignments saved.' }).waitFor();

  await page.locator('#controlRoutingTestInput').fill('red');
  await page.locator('#runControlRoutingTest').click();
  await page.locator('#controlRoutingTestResult').filter({ hasText: '#ff0000 // 2 SENT // 0 FAILED' }).waitFor();

  await page.locator('#twitchEffectProgram > summary').click();
  await page.locator('label:has(#twitchEffectsEnabled)').click();
  await page.locator('label:has(#twitchEffectsReturn)').click();
  await page.locator('label:has([data-effect-fixture-id="effect-only"])').click();
  await page.locator('label:has([data-effect-prefix-toggle="effect-only"])').click();
  await page.locator('[data-effect-prefix-input="effect-only"]').fill('fx');
  await page.locator('#saveTwitchEffects').click();
  await page.locator('#twitchEffectsNotice').filter({ hasText: 'DYNAMIC COMMANDS ENABLED FOR 1 FIXTURE.' }).waitFor();
  const effectSettings = await fetch(`${base}/twitch/light-effects`).then(response => response.json());
  assert.deepEqual(effectSettings.fixtureIds, ['effect-only']);
  assert.deepEqual(effectSettings.prefixes, { 'effect-only': 'fx' });
  assert.equal(effectSettings.returnEffect, true);
  await page.locator('#twitchColorExample').fill('fx fade red, blue slow');
  await page.locator('#previewTwitchColor').click();
  await page.locator('#twitchPreviewResult').filter({ hasText: 'FADE // SLOW // 1 effect targets' }).waitFor();

  await page.locator('#twitchColorExample').fill('light red 40%');
  await page.locator('#previewTwitchColor').click();
  await page.locator('#twitchPreviewResult').filter({ hasText: '#ff5959 // 40% // 2 targets' }).waitFor();
  await page.locator('#twitchColorExample').fill('red');
  await page.locator('#previewTwitchColor').click();
  await page.locator('#twitchPreviewResult').filter({ hasText: '#ff0000 // 100%' }).waitFor();

  await page.locator('#addTwitchFixtureGroup').click();
  const group = page.locator('.fixtureDropZone').nth(2);
  await group.locator('input[aria-label="Group name"]').fill('Right only');
  await group.locator('input[aria-label="Group prefix"]').fill('desk');
  await page.locator('.fixtureChip[data-fixture-id="right"]').click();
  await page.locator('#fixtureDestination').selectOption({ label: 'Right only' });
  await page.locator('#moveSelectedFixture').click();
  assert.equal(await page.locator('[data-drop-zone="active-fixtures"] .fixtureChip').count(), 1);
  assert.equal(await group.locator('.fixtureChip[data-fixture-id="right"]').count(), 1);
  await page.locator('#saveTwitchProgram').click();
  await page.waitForFunction(() => document.getElementById('twitchProgramControls').disabled === false);
  const savedGroups = await fetch(`${base}/twitch/lights`).then(response => response.json());
  assert.ok(savedGroups.rules.some(row => row.name === 'Right only'), JSON.stringify(savedGroups));
  const targetOptions = await page.locator('#lightTarget option').allTextContents();
  assert.ok(targetOptions.includes('GROUP: Right only'), JSON.stringify(targetOptions));
  await page.locator('#lightTarget').selectOption({ label: 'GROUP: Right only' });
  await page.locator('#colorText').fill('blue');
  await page.locator('#applyColor').click();
  await page.locator('#colorResult').filter({ hasText: 'Dry run: #0000ff at 100% matched right.' }).waitFor();
  await page.locator('#twitchColorExample').fill('desk LIGHT BLEU');
  await page.locator('#previewTwitchColor').click();
  await page.locator('#twitchPreviewResult').filter({ hasText: '#5959ff // 100% // 1 targets' }).waitFor();

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const overflow = await page.evaluate(() => ({ page: [document.documentElement.scrollWidth, document.documentElement.clientWidth], offenders: [...document.querySelectorAll('*')].filter(node => node.getBoundingClientRect().right > document.documentElement.clientWidth + 1).slice(0, 8).map(node => [node.tagName, node.id, node.className, Math.round(node.getBoundingClientRect().right)]) }));
    assert.equal(overflow.page[0] <= overflow.page[1] + 1, true, JSON.stringify(overflow));
    if (process.env.RAVELINK_CAPTURE_UI === '1') {
      const output = path.join(__dirname, '../runtime/logs'); fs.mkdirSync(output, { recursive: true });
      await page.screenshot({ path: path.join(output, `twitch-program-${width}.png`), fullPage: true });
    }
  }
  await page.locator('#twitchRoutingMode').selectOption('off');
  await page.locator('#saveTwitchProgram').click();
  await page.locator('#twitchProgramNotice').filter({ hasText: 'Channel-point lighting is off.' }).waitFor();
  await page.locator('#previewTwitchColor').click();
  await page.locator('#twitchPreviewResult').filter({ hasText: 'channel_point_lighting_disabled' }).waitFor();
  assert.equal((await fetch(`${base}/twitch/lights`, { method: 'POST', headers: { origin: 'https://untrusted.invalid', 'content-type': 'application/json' }, body: '{}' })).status, 403);
});
