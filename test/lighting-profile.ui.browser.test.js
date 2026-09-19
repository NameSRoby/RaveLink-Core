const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("playwright");

const createCoreServer = require("../src/app/core/create-core-server");

test("operator can route mixed fixtures and apply a default profile from the HUD", async t => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-profile-ui-"));
  const created = createCoreServer({ runtimeDir, dryRun: true });
  created.services.lightingCore.fixtureRegistry.upsertFixtures([
    { id: "hue-desk", name: "Desk", brand: "hue", bridgeIp: "192.0.2.2", username: "test-user", lightId: 1, engineEnabled: true },
    { id: "wiz-wall", name: "Wall", brand: "wiz", ip: "192.0.2.3", engineEnabled: true }
  ]);
  const server = await new Promise(resolve => {
    const listener = created.app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await created.services.lifecycle.stopAll();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "networkidle" });
  await page.locator('[data-light-tab="profiles"]').click();
  await page.locator("#lightingProfileFixtures .profileFixtureCard").first().waitFor();
  assert.equal(await page.locator("#lightingProfileFixtures .profileFixtureCard").count(), 2);
  await page.locator("#lightingProfileName").fill("Streaming default");
  await page.locator("#lightingProfileDefault").check();
  await page.locator('[data-fixture-id="hue-desk"] [data-route]').check();
  await page.locator('[data-fixture-id="hue-desk"] [data-field="mode"]').selectOption("temperature");
  await page.locator('[data-fixture-id="wiz-wall"] [data-route]').check();
  await page.locator('[data-fixture-id="wiz-wall"] [data-field="color"]').fill("#123456");
  await page.locator("#saveLightingProfile").click();
  await page.locator("#lightingProfileResult").filter({ hasText: "Profile saved" }).waitFor();
  await page.locator("#applyDefaultLightingProfile").click();
  await page.locator("#lightingProfileResult").filter({ hasText: "Default profile applied to 2 fixtures" }).waitFor();
  await page.locator('[data-light-tab="control"]').click();
  const quickProfile = page.locator('#lightingProfileQuickBar .profileQuickButton').filter({ hasText: 'Streaming default' });
  await quickProfile.click();
  await page.locator('#lightingProfileQuickStatus').filter({ hasText: '2 APPLIED' }).waitFor();
  assert.deepEqual(errors, []);
});
