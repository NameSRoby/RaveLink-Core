const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const createServer = require('../src/app/core/create-core-server');

test('room layout alpha places mixed-brand fixtures and explains segment capability boundaries', async t => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ravelink-layout-ui-'));
  const created = createServer({ runtimeDir, dryRun: true });
  created.services.lightingCore.fixtureRegistry.upsertFixtures([
    { id: 'hue-strip', name: 'Hue strip', brand: 'hue', bridgeIp: '192.0.2.2', username: 'test', lightId: 1 },
    { id: 'govee-strip', name: 'Govee strip', brand: 'govee', ip: '192.0.2.3' }
  ]);
  const routing = created.services.lightingCore.twitchLightRouting.snapshot();
  created.services.lightingCore.twitchLightRouting.save({ ...routing, mode: 'assignments', rules: [{ id: 'active-fixtures', name: 'Active Fixtures', prefix: '', enabled: true, fixtureIds: ['hue-strip', 'govee-strip'] }] });
  const server = await new Promise(resolve => { const listener = created.app.listen(0, '127.0.0.1', () => resolve(listener)); });
  let browser;
  t.after(async () => { if (browser) await browser.close(); await created.services.lifecycle.stopAll(); await new Promise(resolve => server.close(resolve)); fs.rmSync(runtimeDir, { recursive: true, force: true }); });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.locator('[data-light-tab="layout"]').click();
  await page.locator('#layoutFixtureSelect').waitFor({ state: 'visible' });
  await page.waitForTimeout(500);
  assert.deepEqual(errors, []);
  assert.equal(await page.locator('#layoutFixtureSelect option').count(), 2);
  await page.locator('#layoutFixtureSelect').selectOption('hue-strip');
  await page.locator('#layoutKind').selectOption('strip');
  await page.locator('#layoutX').fill('20'); await page.locator('#layoutY').fill('30'); await page.locator('#layoutRotation').fill('90');
  await page.locator('#placeLayoutFixture').click();
  await page.locator('#layoutFixtureSelect').selectOption('govee-strip');
  await page.locator('#layoutX').fill('80'); await page.locator('#layoutY').fill('70'); await page.locator('#placeLayoutFixture').click();
  await page.locator('#saveLightingLayout').click();
  await page.locator('#lightingLayoutResult').filter({ hasText: '2 POSITIONED FIXTURES' }).waitFor();
  assert.equal(await page.locator('.layoutMarker').count(), 2);
  const saved = await fetch(`${base}/lighting-layout`).then(response => response.json());
  assert.equal(saved.placements['hue-strip'].kind, 'strip');
  assert.equal(saved.placements['hue-strip'].rotation, 90);
  assert.match(await page.locator('.segmentCapabilityGrid').innerText(), /Entertainment API v2/);
  await page.locator('#layoutRoutingTestInput').fill('red');
  await page.locator('#runLayoutRoutingTest').click();
  await page.locator('#layoutRoutingTestResult').filter({ hasText: '#ff0000 // 2 SENT // 0 FAILED' }).waitFor();

  await page.locator('[data-light-tab="lab"]').click();
  await page.locator('#lightingLabFixtures .labFixtureCard').first().waitFor();
  assert.equal(await page.locator('#lightingLabFixtures .labFixtureCard').count(), 2);
  await page.locator('#labBrightnessLimit').fill('75');
  await page.locator('label:has([data-lab-excluded="hue-strip"])').click();
  await page.locator('#saveLightingLab').click();
  await page.locator('#lightingLabNotice').filter({ hasText: 'LIGHT LAB SAVED' }).waitFor();
  await page.locator('#labPreviewCommand').fill('red');
  await page.locator('#runLabPreview').click();
  await page.locator('#labPreviewResult').filter({ hasText: '1 TARGETS' }).waitFor();
  assert.equal(await page.locator('#lightingLabMap .previewTarget').count(), 1);
  assert.equal(await page.locator('#labChaseRouteName').count(), 0);
  await page.setViewportSize({ width: 390, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true);
  assert.deepEqual(errors, []);
});
