const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("playwright");
const createCoreServer = require("../src/app/core/create-core-server");

test("Light Commands builds and copies guides from active saved routes", async t => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-command-guide-"));
  const created = createCoreServer({ runtimeDir, dryRun: true });
  const lighting = created.services.lightingCore;
  lighting.fixtureRegistry.upsertFixtures([
    { id: "hue-desk", name: "Desk Hue", brand: "hue", bridgeIp: "192.0.2.2", username: "test-user", lightId: 1, engineEnabled: true, twitchEnabled: true },
    { id: "wiz-wall", name: "Wall WiZ", brand: "wiz", ip: "192.0.2.3", engineEnabled: true, twitchEnabled: true }
  ]);
  assert.equal(lighting.twitchLightRouting.save({ revision: 0, mode: "assignments", parser: { allowFuzzy: true, allowDescriptors: true, defaultBrightness: 80 }, rules: [
    { id: "active", name: "Active Fixtures", prefix: "", enabled: true, fixtureIds: ["hue-desk"] },
    { id: "wall", name: "Wall", prefix: "wall", enabled: true, fixtureIds: ["wiz-wall"] }
  ] }).ok, true);
  assert.equal(lighting.twitchLightEffects.save({ revision: 0, enabled: true, returnEffect: true, fixtureIds: ["hue-desk", "wiz-wall"], prefixes: { "wiz-wall": "wall" } }).ok, true);
  const server = await new Promise(resolve => { const listener = created.app.listen(0, "127.0.0.1", () => resolve(listener)); });
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await created.services.lifecycle.stopAll();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin, { waitUntil: "networkidle" });
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
  assert.equal((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n"), compact);
  assert.deepEqual(errors, []);
});
