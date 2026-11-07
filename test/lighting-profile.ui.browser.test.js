const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("playwright");

const createCoreServer = require("../src/app/core/create-core-server");

test("operator can route mixed fixtures and apply a default profile from the HUD", async (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-profile-ui-"));
  const created = createCoreServer({ runtimeDir, dryRun: true });
  created.services.lightingCore.fixtureRegistry.upsertFixtures([
    {
      id: "hue-desk",
      name: "Desk",
      brand: "hue",
      bridgeIp: "192.0.2.2",
      username: "test-user",
      lightId: 1,
      engineEnabled: true,
    },
    {
      id: "wiz-wall",
      name: "Wall",
      brand: "wiz",
      ip: "192.0.2.3",
      engineEnabled: true,
    },
  ]);
  const server = await new Promise((resolve) => {
    const listener = created.app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await created.services.lifecycle.stopAll();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`, {
    waitUntil: "networkidle",
  });
  await page.locator('[data-tab="lights"]').click();
  await page.locator('[data-light-tab="profiles"]').click();
  await page.locator("#lightingProfileAvailableFixtures .profileFixtureCard").first().waitFor();
  assert.equal(
    await page.locator("#lightingProfileFixtureSettings .profileTargetControls").count(),
    0,
  );
  await page.locator("#lightingProfileName").fill("Streaming default");
  await page.locator("#lightingProfileDefault").check();
  await page.locator('[data-fixture-id="hue-desk"] [data-route]').check();
  await page.locator('[data-fixture-id="hue-desk"] .profileFixtureSelect').click();
  await page.locator('#lightingProfileFixtureSettings [data-choice-value="temperature"]').click();
  await page.locator('[data-fixture-id="wiz-wall"] [data-route]').check();
  await page.locator('[data-fixture-id="wiz-wall"] .profileFixtureSelect').click();
  await page.locator('#lightingProfileFixtureSettings [data-field="color"]').fill("#123456");
  assert.equal(
    await page.locator("#lightingProfileFixtureSettings .profileTargetControls").count(),
    1,
  );
  await page.locator("#saveLightingProfile").click();
  await page.locator("#lightingProfileResult").filter({ hasText: "Profile saved" }).waitFor();
  await page.locator("#applyDefaultLightingProfile").click();
  await page
    .locator("#lightingProfileResult")
    .filter({ hasText: "Default profile applied to 2 fixtures" })
    .waitFor();
  await page.locator('[data-light-tab="control"]').click();
  const quickProfile = page
    .locator("#lightingProfileQuickBar .profileQuickButton")
    .filter({ hasText: "Streaming default" });
  await quickProfile.click();
  await page.locator("#lightingProfileQuickStatus").filter({ hasText: "2 APPLIED" }).waitFor();
  await page.locator('[data-tab="dashboard"]').click();
  await page.locator("#deckButtonMode").click();
  await page.locator("#deckAddButton").click();
  await page.locator('[data-deck-action="lighting.profile:streaming-default"]').click();
  assert.equal(await page.locator("#deckButtonSymbol").inputValue(), "💡");
  assert.equal(
    await page
      .locator('#deckEditor [aria-label="Button appearance preview"]')
      .getAttribute("data-profile-leds"),
    "2",
  );
  await page.locator("#deckSaveButton").click();
  const profileButton = page
    .locator("#deckGrid .deckButton")
    .filter({ hasText: "Streaming default" });
  await profileButton.waitFor();
  assert.equal(await profileButton.getAttribute("data-profile-leds"), "2");
  assert.equal(await profileButton.getAttribute("data-profile-lighting"), "true");
  await profileButton.click();
  await page.waitForFunction(
    () =>
      document.querySelector('#deckGrid [data-profile-lighting="true"]')?.dataset.ledState ===
      "active",
  );
  await page.waitForFunction(
    () =>
      document.querySelector('#deckGrid [data-profile-lighting="true"]')?.dataset.ledState ===
      "rest",
    undefined,
    { timeout: 2000 },
  );
  const origin = new URL(page.url()).origin;
  const saved = await (await fetch(origin + "/lighting-profiles")).json();
  const changed = saved.profiles[0];
  changed.fixtureTargets["wiz-wall"].color = "#ff00aa";
  assert.equal(
    (
      await fetch(origin + "/lighting-profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify(changed),
      })
    ).status,
    200,
  );
  await page.waitForFunction(() =>
    document
      .querySelector('#deckGrid [data-profile-lighting="true"] .deckLedSource')
      ?.style.getPropertyValue("--profile-leds")
      .includes("#ff00aaff"),
  );
  await page.locator("#deckEdit").click();
  await profileButton.click();
  await page.locator("#deckButtonColor").fill("#abcdef");
  assert.equal(await page.locator("#deckButtonProfileColors").isChecked(), false);
  await page.locator("#deckSaveButton").click();
  await page.locator("#deckEditor").waitFor({ state: "hidden" });
  assert.equal(await profileButton.getAttribute("data-profile-lighting"), "false");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-tab="lights"]').click();
  await page.locator('[data-light-tab="profiles"]').click();
  await page.locator("#lightingProfileCards .lightingProfileCard").click();
  await page.locator('[data-fixture-id="wiz-wall"] .profileFixtureSelect').click();
  assert(await page.locator("#lightingProfileFixtureSettings").isVisible());
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true,
  );
  assert.deepEqual(errors, []);
});
