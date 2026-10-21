const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { chromium } = require("playwright");
const createCore = require("../src/app/core/create-core-server");
async function environment(t) {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-hue-area-"));
  let failure = false;
  const { app, services } = createCore({
    runtimeDir,
    dryRun: true,
    axios: {
      get: async () => {
        if (failure) throw Error("private-area-user at 192.0.2.5");
        return {
          data: {
            4: {
              type: "Entertainment",
              name: "Gaming desk",
              lights: ["1", "2"],
              stream: { active: false },
            },
            5: {
              type: "Entertainment",
              name: "Other room",
              lights: ["3"],
              stream: { active: true },
            },
          },
        };
      },
    },
  });
  const core = services.lightingCore;
  core.fixtureRegistry.upsertFixtures(
    [1, 2, 3].map((lightId) => ({
      id: `area-light-${lightId}`,
      name: `Area light ${lightId}`,
      brand: "hue",
      enabled: true,
      lightId,
      bridgeIp: "192.0.2.5",
      bridgeId: "001788FFFE123456",
      username: "private-area-user",
      clientKey: "a".repeat(32),
    })),
  );
  const server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  t.after(async () => {
    await services.lifecycle.stopAll();
    await new Promise((r) => server.close(r));
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });
  return {
    core,
    runtimeDir,
    setFailure: () => {
      failure = true;
    },
    url: `http://127.0.0.1:${server.address().port}`,
  };
}
test("fixture Entertainment routes reject foreign origins and never disclose credentials", async (t) => {
  const e = await environment(t);
  const url = e.url + "/fixtures/area-light-1/hue-entertainment";
  const found = await fetch(url);
  assert.match(found.headers.get("cache-control"), /no-store/);
  const body = await found.text();
  assert(!body.includes("private-area-user"));
  assert(!body.includes("a".repeat(32)));
  assert.equal(JSON.parse(body).areas[0].includesFixture, true);
  for (const method of ["GET", "PUT"]) {
    const response = await fetch(url, {
      method,
      headers: { Origin: "https://outside.example", "Content-Type": "application/json" },
      ...(method === "PUT" ? { body: JSON.stringify({ areaId: "4" }) } : {}),
    });
    assert.equal(response.status, 403);
  }
  assert.equal(
    (
      await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ areaId: "../../config" }),
      })
    ).status,
    400,
  );
  assert.equal(
    e.core.fixtureRegistry.getFixtures().find((f) => f.id === "area-light-1").entertainmentAreaId,
    "",
  );
  e.setFailure();
  const failure = await (await fetch(url)).text();
  assert(!failure.includes("private-area-user"));
  assert(!failure.includes("192.0.2.5"));
});
test("fixture editor discovers matching areas, saves compatible lights, accepts manual IDs and explains missing keys", async (t) => {
  const e = await environment(t);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(e.url, { waitUntil: "networkidle" });
    await page.locator('[data-tab="fixtures"]').click();
    await page.locator('[data-fixture-edit="area-light-1"]').click();
    await page.locator("#hueEntertainmentStatus").filter({ hasText: "2 areas found" }).waitFor();
    assert.equal(await page.locator("#hueEntertainmentArea").inputValue(), "4");
    assert.equal(await page.locator("#hueEntertainmentKey").inputValue(), "");
    assert.match(await page.locator("#hueEntertainmentAreaNames").textContent(), /Gaming desk/);
    await page.locator("#hueEntertainmentApply").check();
    await page.locator("#saveHueEntertainment").click();
    await page
      .locator("#hueEntertainmentStatus")
      .filter({ hasText: "saved for 2 lights" })
      .waitFor();
    const rows = e.core.fixtureRegistry.getFixtures();
    assert.equal(rows.find((f) => f.id === "area-light-2").entertainmentAreaId, "4");
    assert.equal(rows.find((f) => f.id === "area-light-3").entertainmentAreaId, "");
    await page.locator("#hueEntertainmentArea").fill("12345678-abcd-1234-abcd-123456789abc");
    assert.equal(await page.locator("#hueEntertainmentApply").isDisabled(), true);
    await page.locator("#saveHueEntertainment").click();
    await page
      .locator("#hueEntertainmentStatus")
      .filter({ hasText: "saved for 1 light" })
      .waitFor();
    await page.locator('[data-fixture-edit="area-light-1"]').click();
    await page.locator("#hueEntertainmentStatus").filter({ hasText: "2 areas found" }).waitFor();
    assert.equal(
      await page.locator("#hueEntertainmentArea").inputValue(),
      "12345678-abcd-1234-abcd-123456789abc",
    );
    e.core.fixtureRegistry.upsertFixture({ id: "area-light-1", clientKey: "" });
    await page.locator('[data-fixture-edit="area-light-1"]').click();
    await page
      .locator("#hueEntertainmentStatus")
      .filter({ hasText: "Streaming key missing" })
      .waitFor();
    await page.locator("#saveHueEntertainment").click();
    await page
      .locator("#hueEntertainmentStatus")
      .filter({ hasText: "Re-pair using the bridge link button" })
      .waitFor();
    await page.locator("#hueEntertainmentKey").fill("a".repeat(32));
    await page.locator("#saveHueEntertainment").click();
    await page
      .locator("#hueEntertainmentStatus")
      .filter({ hasText: "saved for 1 light" })
      .waitFor();
    assert.equal(await page.locator("#hueEntertainmentKey").inputValue(), "");
    assert.deepEqual(errors, []);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    // Put the discovered area back for the next viewport's automatic selection.
    e.core.fixtureRegistry.upsertFixture({ id: "area-light-1", entertainmentAreaId: "" });
    await page.close();
  }
});
