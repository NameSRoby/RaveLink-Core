/** Real editor + shared Core state; all keyboard execution is replaced by a fake owner. */
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { chromium } = require("playwright"),
  createCore = require("../src/app/core/create-core-server");
test("custom toggles build both presses, preview each face and synchronize successful states across screens", async (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "rvl-toggle-")),
    calls = [];
  const core = createCore({
    runtimeDir,
    dryRun: true,
    desktopActions: {
      catalog: () => [
        {
          id: "native.hotkey",
          label: "Keyboard shortcut",
          available: true,
          symbol: "K",
          group: "Keyboard",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: { shortcut: { type: "string" } },
            required: ["shortcut"],
          },
          defaults: { shortcut: "F13" },
        },
      ],
      execute: async (_id, params) => {
        calls.push(params.shortcut);
        return { ok: true };
      },
      integrations: async () => ({ discord: { available: false } }),
      shutdown() {},
    },
  });
  const server = await new Promise((resolve) => {
    const s = core.app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await core.services.lifecycle.stopAll();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } }),
    errors = [];
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => errors.push(error.message));
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.goto(base);
  await page.locator("#deckButtonMode").click();
  await page.locator("#deckAddButton").click();
  await page.getByRole("button", { name: "Create a toggle", exact: true }).click();
  await page.locator("#deckButtonName").fill("My toggle");
  await page
    .getByRole("textbox", { name: "Keyboard trigger (RaveLink focused)", exact: true })
    .focus();
  await page.keyboard.press("Control+Shift+k");
  await page.locator('[data-deck-action="native.hotkey"]').click();
  await page.locator("#deckToggleActionTarget").selectOption("second");
  await page.locator('[data-deck-action="native.hotkey"]').click();
  await page.locator('[data-deck-parameter="shortcut"]').nth(1).fill("F14");
  await page.locator("#deckToggleoffLabel").fill("Quiet");
  await page.locator("#deckToggleonLabel").fill("Broadcast");
  await page.locator("#deckToggleonSymbol").fill("B");
  await page.locator("#deckToggleonColor").fill("#58ccaa");
  assert.equal(
    await page.locator(".deckToggleStateCard").nth(1).locator(".deckButtonTitle").textContent(),
    "Broadcast",
  );
  assert.equal(calls.length, 0, "editor previews never execute actions");
  await page.locator("#deckSaveButton").click();
  await page.locator("#deckEditor").waitFor({ state: "hidden" });
  const button = core.services.controlDeck
    .snapshot()
    .config.pages.flatMap((p) => p.buttons)
    .find((b) => b.title === "My toggle");
  assert.equal(button.steps[0].params.shortcut, "F13");
  assert.equal(button.activationKey, "Ctrl+Shift+KeyK");
  assert.equal(button.alternateSteps[0].params.shortcut, "F14");
  const other = await browser.newPage();
  await other.goto(base);
  await other.locator("#deckButtonMode").click();
  const tile = page.locator(`[data-deck-button="${button.id}"]`),
    remote = other.locator(`[data-deck-button="${button.id}"]`);
  await tile.click();
  await page.waitForFunction(
    (id) =>
      document.querySelector(`[data-deck-button="${id}"]`).getAttribute("aria-pressed") === "true",
    button.id,
  );
  await other.waitForFunction(
    (id) =>
      document.querySelector(`[data-deck-button="${id}"] .deckButtonTitle`).textContent ===
      "Broadcast",
    button.id,
  );
  assert.deepEqual(calls, ["F13"]);
  assert.equal(
    await remote.evaluate((el) => el.style.getPropertyValue("--deck-led-color")),
    "#58ccaa",
  );
  await remote.click();
  await page.waitForFunction(
    (id) =>
      document.querySelector(`[data-deck-button="${id}"] .deckButtonTitle`).textContent === "Quiet",
    button.id,
  );
  assert.deepEqual(calls, ["F13", "F14"]);
  assert.deepEqual(errors, []);
});
