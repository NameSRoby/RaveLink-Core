const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  http = require("node:http");
const { chromium } = require("playwright"),
  createCore = require("../src/app/core/create-core-server");
const listen = (app) =>
  new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
test("LAN icon library is lazy, searchable, keyboard accessible and saves tinted portable media without running actions", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rvl-icons-"));
  const core = createCore({
    runtimeDir: root,
    dryRun: true,
    desktopActions: {
      catalog: () => [
        {
          id: "native.hotkey",
          label: "Keyboard shortcut",
          available: true,
          parameters: {
            type: "object",
            properties: { shortcut: { type: "string" } },
            required: ["shortcut"],
          },
          defaults: { shortcut: "F13" },
        },
      ],
      execute: () => {
        throw Error("must_not_execute");
      },
      shutdown() {},
      integrations: async () => ({ discord: { available: false } }),
    },
  });
  const server = await listen(core.app),
    reservation = await listen(http.createServer()),
    port = reservation.address().port;
  await new Promise((r) => reservation.close(r));
  await core.services.networkSharing.configure({ enabled: true, port }, server.address().port);
  const base = core.services.networkSharing.snapshot().urls[0] || "http://127.0.0.1:" + port;
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await core.services.lifecycle.stopAll();
    await new Promise((r) => server.close(r));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } }),
    errors = [],
    requests = [];
  page.setDefaultTimeout(10000);
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => requests.push({ path: new URL(r.url()).pathname, method: r.method() }));
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.locator("#deckButtonMode").click();
  await page.locator("#deckEdit").click();
  const mic = page.locator('[data-deck-button="discord-mic"]');
  await mic.click();
  await page.getByRole("button", { name: "⌨ Keyboard key", exact: true }).click();
  await page.getByLabel("Rare keyboard key", { exact: true }).selectOption("F24");
  assert.equal(await page.locator('[data-deck-parameter="shortcut"]').inputValue(), "F24");
  assert.equal(requests.filter((r) => r.path === "/button-icons/catalog.json").length, 0);
  await page.getByRole("button", { name: "Choose from icon library", exact: true }).click();
  const picker = page.locator("#deckIconPicker");
  await picker.waitFor();
  assert.equal(await picker.locator(".deckIconGrid button").count(), 250);
  await picker.getByLabel("Search button icons", { exact: true }).fill("microphone");
  assert((await picker.locator(".deckIconGrid button").count()) > 0);
  await picker.getByLabel("Icon category", { exact: true }).selectOption("Lighting");
  assert.equal(await picker.locator(".deckIconGrid button").count(), 0);
  await picker.getByLabel("Search button icons", { exact: true }).fill("moon");
  await picker.getByRole("button", { name: "Moon", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  assert(await page.evaluate(() => document.activeElement.closest(".deckIconGrid") !== null));
  await picker.getByLabel("Icon category", { exact: true }).selectOption("Audio");
  await picker.getByLabel("Search button icons", { exact: true }).fill("microphone");
  await picker.getByRole("button", { name: "Mic", exact: true }).click();
  await picker.getByLabel("Icon color", { exact: true }).fill("#58ccaa");
  await picker.getByRole("button", { name: "Use icon", exact: true }).click();
  await page.waitForFunction(
    () =>
      !document.getElementById("deckIconPicker") ||
      document.querySelector("#deckIconPicker .deckEditorNotice").textContent,
  );
  if (await picker.count()) throw Error(await picker.locator(".deckEditorNotice").textContent());
  await picker.waitFor({ state: "detached" });
  assert.equal(
    requests.filter((r) => r.path === "/api/control-deck/media" && r.method === "POST").length,
    1,
  );
  const image = page.locator(".deckAppearancePreview img");
  await image.evaluate((img) => img.decode());
  const raster = await image.evaluate((img) => {
    const c = document.createElement("canvas");
    c.width = c.height = 256;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const pixels = ctx.getImageData(0, 0, 256, 256).data;
    let colored = 0;
    for (let i = 0; i < pixels.length; i += 4)
      if (
        pixels[i + 3] > 240 &&
        Math.abs(pixels[i] - 88) < 2 &&
        Math.abs(pixels[i + 1] - 204) < 2 &&
        Math.abs(pixels[i + 2] - 170) < 2
      )
        colored++;
    return { width: img.naturalWidth, colored };
  });
  assert.equal(raster.width, 256);
  assert(raster.colored > 1000);
  await page.locator("#deckSaveButton").click();
  await page.locator("#deckEditor").waitFor({ state: "hidden" });
  const value = (
    await (await fetch("http://127.0.0.1:" + server.address().port + "/api/control-deck")).json()
  ).value;
  const saved = value.config.pages.flatMap((p) => p.buttons).find((b) => b.id === "discord-mic");
  assert.match(saved.appearance.imageId, /^[a-f0-9]{64}\.png$/);
  await page.reload({ waitUntil: "domcontentloaded" });
  await mic.waitFor();
  await page.locator("#deckEdit").click();
  await mic.click();
  assert(
    (await page.locator(".deckAppearancePreview img").getAttribute("src")).endsWith(
      saved.appearance.imageId,
    ),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Choose from icon library", exact: true }).click();
  await picker.waitFor();
  assert(await picker.evaluate((el) => el.scrollWidth <= el.clientWidth + 1));
  await picker.getByLabel("Search button icons", { exact: true }).fill("camera");
  await picker.screenshot({ path: path.resolve("runtime/button-icons-phone-private.png") });
  await picker.getByRole("button", { name: "Camera", exact: true }).click();
  await picker.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Choose from icon library", exact: true }).click();
  await picker.waitFor();
  await picker.getByRole("button", { name: "Close", exact: true }).click();
  assert.equal(
    requests.filter((r) => r.path === "/api/control-deck/media" && r.method === "POST").length,
    1,
    "cancel does not upload another icon",
  );
  assert.equal(requests.filter((r) => r.method === "POST" && /\/run$/.test(r.path)).length, 0);
  assert.equal(
    requests.filter((r) => r.path === "/button-icons/catalog.json").length,
    2,
    "catalog loads once per page and is cached across subsequent openings",
  );
  assert.deepEqual(errors, []);
});
