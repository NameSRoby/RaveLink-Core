const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("playwright");
const createCoreServer = require("../src/app/core/create-core-server");

test("Light Commands builds and copies guides from active saved routes", async (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-command-guide-"));
  const created = createCoreServer({
    runtimeDir,
    dryRun: true,
    fixtureSecretVaultOptions: require("./support/fixture-vault-codec.cjs"),
  });
  const lighting = created.services.lightingCore;
  const savedFixtures = lighting.fixtureRegistry.upsertFixtures([
    {
      id: "hue-desk",
      name: "Desk Hue",
      brand: "hue",
      bridgeIp: "192.0.2.2",
      username: "test-user",
      lightId: 1,
      engineEnabled: true,
      twitchEnabled: true,
    },
    {
      id: "wiz-wall",
      name: "Wall WiZ",
      brand: "wiz",
      ip: "192.0.2.3",
      engineEnabled: true,
      twitchEnabled: true,
    },
  ]);
  assert.equal(savedFixtures.ok, true, JSON.stringify(savedFixtures));
  assert.equal(
    lighting.twitchLightRouting.save({
      revision: 0,
      mode: "assignments",
      parser: {
        allowFuzzy: true,
        allowDescriptors: true,
        defaultBrightness: 80,
      },
      rules: [
        {
          id: "active",
          name: "Active Fixtures",
          prefix: "",
          enabled: true,
          fixtureIds: ["hue-desk"],
        },
        {
          id: "wall",
          name: "Wall",
          prefix: "wall",
          enabled: true,
          fixtureIds: ["wiz-wall"],
        },
      ],
    }).ok,
    true,
  );
  assert.equal(
    lighting.twitchLightEffects.save({
      revision: 0,
      enabled: true,
      returnEffect: true,
      fixtureIds: ["hue-desk", "wiz-wall"],
      prefixes: { "wiz-wall": "wall" },
    }).ok,
    true,
  );
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
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin,
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.locator('[data-tab="lights"]').click();
  await page.locator('[data-light-tab="commands"]').click();
  await page.locator("#lightCommandsStatus").filter({ hasText: "GUIDE READY" }).waitFor();
  const compact = await page.locator("#compactLightCommands").textContent();
  const detailed = await page.locator("#detailedLightCommands").textContent();
  assert.match(compact, /Every routed light: all <color>/);
  assert.match(compact, /Dynamic subset: wall <effect>/);
  assert.match(detailed, /ALL static route \(2\): Desk Hue, Wall WiZ/);
  assert.match(detailed, /No prefix \/ ALL dynamic route \(2\): Desk Hue, Wall WiZ/);
  assert.match(detailed, /Default brightness when omitted: 80%/);
  await page.locator("#copyCompactLightCommands").click();
  await page.locator("#copyCompactLightCommands").filter({ hasText: "COPIED" }).waitFor();
  assert.equal(
    (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n"),
    compact,
  );
  await page.locator('[data-guide-format="twitch"]').click();
  const twitch = await page.locator("#compactLightCommands").textContent();
  assert.match(twitch, /\*\*RAVELINK LIGHT COMMANDS\*\*/);
  assert.match(twitch, /&lt;color&gt;/);
  await page.locator('[data-guide-format="discord"]').click();
  const discord = await page.locator("#compactLightCommands").textContent();
  assert.match(discord, /^```text\n/);
  assert(discord.length < 2000);
  await page.locator('[data-guide-length="detailed"]').click();
  assert.equal(await page.locator('[data-guide-card="compact"]').isVisible(), false);
  assert.equal(await page.locator('[data-guide-card="detailed"]').isVisible(), true);
  assert((await page.locator("#detailedLightCommands").textContent()).length < 2000);
  if (await page.locator("#lightGuideNextPart").isVisible()) {
    const first = await page.locator("#detailedLightCommands").textContent();
    await page.locator("#lightGuideNextPart").click();
    assert.notEqual(await page.locator("#detailedLightCommands").textContent(), first);
    await page.locator("#copyDetailedLightCommands").click();
    await page.locator("#copyDetailedLightCommands").filter({ hasText: "COPIED" }).waitFor();
    assert.equal(
      (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n"),
      await page.locator("#detailedLightCommands").textContent(),
    );
  }
  assert.deepEqual(errors, []);
});
