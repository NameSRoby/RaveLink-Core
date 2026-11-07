const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  http = require("node:http");
const { chromium } = require("playwright");
const createCore = require("../src/app/core/create-core-server"),
  fixture = require("./support/obs-fixture.cjs");
const listen = (app) =>
  new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
test("custom OBS buttons are built without JSON, preview safely, operate over LAN, and remain readable on phones", async (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "rvl-obs-browser-")),
    model = fixture();
  const core = createCore({
    runtimeDir,
    dryRun: true,
    obsControlOptions: { WebSocketImpl: model.WebSocketImpl, codec: model.codec },
    desktopActions: {
      catalog: () => [
        {
          id: "native.hotkey",
          title: "Keyboard shortcut",
          parameters: { type: "object", properties: { shortcut: { type: "string" } } },
        },
      ],
      refresh: async () => {},
      shutdown() {},
      integrations: async () => ({ discord: { available: false } }),
    },
  });
  const server = await listen(core.app),
    reservation = await listen(http.createServer()),
    port = reservation.address().port;
  await new Promise((r) => reservation.close(r));
  const local = "http://127.0.0.1:" + server.address().port;
  const address =
    Object.values(os.networkInterfaces())
      .flat()
      .find((r) => r && r.family === "IPv4" && !r.internal)?.address || "127.0.0.1";
  const base = "http://" + address + ":" + port;
  const share = await fetch(local + "/api/network-sharing", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Origin: local },
    body: JSON.stringify({ enabled: true, port }),
  });
  assert.equal(share.status, 200);
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await core.services.lifecycle.stopAll();
    await new Promise((r) => server.close(r));
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } }),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base, { waitUntil: "domcontentloaded" });
  model.imageData = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 320;
    c.height = 180;
    const g = c.getContext("2d");
    g.fillStyle = "#562245";
    g.fillRect(0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg");
  });
  await page.getByRole("button", { name: "OBS connection", exact: true }).waitFor();
  await page.getByRole("button", { name: "OBS connection", exact: true }).click();
  await page.locator("#deckObsPanel").waitFor();
  assert(await page.getByRole("heading", { name: "Connect OBS", exact: true }).isVisible());
  await page.locator("#deckObsPanel").getByRole("button", { name: "Close", exact: true }).click();
  await page.locator("#deckButtonMode").click();
  const open = async () => {
    await page.locator("#deckAddButton").click();
    const obsShortcut = await page
        .getByRole("button", { name: "Create an OBS button", exact: true })
        .boundingBox(),
      keyShortcut = await page.locator(".deckEditorQuickActions .deckKeyboardPreset").boundingBox();
    assert(obsShortcut && keyShortcut);
    assert(keyShortcut.y - obsShortcut.y - obsShortcut.height >= 9, "quick actions stay separated");
    await page.getByRole("button", { name: "Create an OBS button", exact: true }).click();
    await page.locator("#deckObsPanel").waitFor();
  };
  await open();
  const panel = page.locator("#deckObsPanel");
  const connectionDetails = panel
    .locator("summary")
    .filter({ hasText: "Connection details / another PC" });
  if (!(await connectionDetails.evaluate((el) => el.parentElement.open)))
    await connectionDetails.click();
  await panel
    .getByLabel("Password (leave blank to keep saved password)", { exact: true })
    .fill("incorrect fixture password");
  await panel.getByRole("button", { name: "Save & connect", exact: true }).click();
  await panel
    .getByText("OBS rejected the password. Check its WebSocket Server Settings.", { exact: true })
    .waitFor();
  assert.equal(
    (await fetch(local + "/health")).status,
    200,
    "failed OBS authentication leaves Core available",
  );
  await page.waitForTimeout(650);
  assert.equal(
    model.sockets.length,
    1,
    "a rejected password does not create an automatic retry loop",
  );
  await panel
    .getByLabel("Password (leave blank to keep saved password)", { exact: true })
    .fill(model.password);
  await panel.getByRole("button", { name: "Save & connect", exact: true }).click();
  await panel.getByText(/^Connected to OBS/).waitFor();
  await page.waitForFunction(
    () => document.querySelector('#deckObsPanel input[type="password"]').value === "",
  );
  await panel.getByLabel("OBS object", { exact: true }).waitFor();
  assert.equal(
    await panel
      .getByLabel("Password (leave blank to keep saved password)", { exact: true })
      .inputValue(),
    "",
  );
  await panel.getByLabel("OBS object", { exact: true }).selectOption("scene:Break");
  await panel.getByLabel("OBS action", { exact: true }).selectOption("scene");
  await panel.getByRole("button", { name: "Preview selected scene", exact: true }).click();
  await panel.locator(".deckObsPreview:not([hidden])").waitFor();
  await panel
    .getByText("Use a captured scene preview as the button image", { exact: true })
    .click();
  await panel.getByLabel("Button label", { exact: true }).fill("Gameplay");
  await panel.getByRole("button", { name: "Add button to this page", exact: true }).click();
  await panel.getByText(/Button added\. Use Edit/).waitFor();
  assert.equal(model.writes().length, 0);
  const saved = (await (await fetch(local + "/api/control-deck")).json()).value.config;
  const sceneButton = saved.pages.flatMap((p) => p.buttons).find((b) => b.title === "Gameplay");
  assert(sceneButton.appearance.imageId.endsWith(".jpg"));
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await page.locator('[data-deck-button="' + sceneButton.id + '"]').click();
  await page.waitForFunction(
    (id) =>
      document.querySelector('[data-deck-button="' + id + '"]')?.getAttribute("data-led-state") ===
      "active",
    sceneButton.id,
  );
  assert.equal(model.program, "Break");
  await open();
  await panel.getByLabel("OBS object", { exact: true }).selectOption("source:Camera");
  await panel.getByText(/This object has no available OBS audio controls/).waitFor();
  assert.equal(
    await panel
      .getByLabel("OBS action", { exact: true })
      .locator('option[value="mute-toggle"]')
      .count(),
    0,
  );
  assert(
    await panel.getByRole("button", { name: "Add button to this page", exact: true }).isDisabled(),
  );
  await panel.getByLabel("OBS object", { exact: true }).selectOption("source:Mic");
  await panel.getByLabel("OBS action", { exact: true }).selectOption("mute-toggle");
  assert.equal(
    await panel
      .getByLabel("OBS action", { exact: true })
      .locator('option[value="filter-toggle"]')
      .count(),
    0,
  );
  await panel.getByLabel("Button label", { exact: true }).fill("OBS mic");
  await panel.getByRole("button", { name: "Add button to this page", exact: true }).click();
  await panel.getByText(/Button added\. Use Edit/).waitFor();
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  const mic = (await (await fetch(local + "/api/control-deck")).json()).value.config.pages
    .flatMap((p) => p.buttons)
    .find((b) => b.title === "OBS mic");
  await page.locator('[data-deck-button="' + mic.id + '"]').click();
  await page.waitForFunction(
    (id) =>
      document.querySelector('[data-deck-button="' + id + '"] .deckButtonState')?.textContent ===
      "Muted",
    mic.id,
  );
  assert.equal(model.muted, true);
  await open();
  await panel.getByLabel("OBS object", { exact: true }).selectOption("source:Camera");
  await panel.getByLabel("OBS action", { exact: true }).selectOption("source-toggle");
  await panel.getByLabel("OBS visibility scene or group", { exact: true }).selectOption("all");
  await panel.getByLabel("Button label", { exact: true }).fill("OBS camera");
  await panel.getByRole("button", { name: "Add button to this page", exact: true }).click();
  await panel.getByText(/Button added\. Use Edit/).waitFor();
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  const camera = (await (await fetch(local + "/api/control-deck")).json()).value.config.pages
    .flatMap((p) => p.buttons)
    .find((b) => b.title === "OBS camera");
  await page.locator('[data-deck-button="' + camera.id + '"]').click();
  await page.waitForFunction(
    (id) =>
      document.querySelector('[data-deck-button="' + id + '"] .deckButtonState')?.textContent ===
      "Hidden",
    camera.id,
  );
  assert.equal(model.items[0].sceneItemEnabled, false);
  await open();
  await panel.getByLabel("OBS object", { exact: true }).selectOption("source:Camera");
  await panel.getByLabel("OBS action", { exact: true }).selectOption("filter-toggle");
  await panel.getByLabel("OBS source filter", { exact: true }).selectOption("Crop");
  await panel.getByLabel("Button label", { exact: true }).fill("Camera crop");
  await page.screenshot({
    path: require("node:path").resolve("runtime/obs-builder-desktop-private.png"),
    fullPage: true,
  });
  await panel.getByRole("button", { name: "Add button to this page", exact: true }).click();
  await panel.getByText(/Button added\. Use Edit/).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await panel.evaluate((e) => e.scrollWidth <= e.clientWidth + 1));
  await page.screenshot({
    path: require("node:path").resolve("runtime/obs-builder-phone-private.png"),
    fullPage: true,
  });
  assert.equal(await panel.locator("textarea").count(), 0, "the OBS builder needs no JSON editing");
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  const filter = (await (await fetch(local + "/api/control-deck")).json()).value.config.pages
    .flatMap((p) => p.buttons)
    .find((b) => b.title === "Camera crop");
  await page.locator('[data-deck-button="' + filter.id + '"]').click();
  await page.waitForFunction(
    (id) =>
      document.querySelector('[data-deck-button="' + id + '"] .deckButtonState')?.textContent ===
      "Off",
    filter.id,
  );
  assert.equal(model.filters[0].filterEnabled, false);
  const forbidden = await fetch(base + "/api/control-deck/obs/connection", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Origin: "https://untrusted.example" },
    body: JSON.stringify({ host: "127.0.0.1", port: 4455, enabled: false }),
  });
  assert.equal(forbidden.status, 403);
  assert.deepEqual(errors, []);
});
