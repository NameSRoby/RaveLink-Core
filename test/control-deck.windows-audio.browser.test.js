/** LAN browser exercises real routing/owners with synthetic audio; no OS changes. */
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  http = require("node:http");
const { chromium } = require("playwright");
const createCore = require("../src/app/core/create-core-server"),
  createAudio = require("../src/domains/control-deck/windows-audio.service");
const listen = (app) =>
  new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
test("Windows controls work over LAN with live audio, safe pinning, media and phone layouts", async (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-windows-audio-ui-"));
  const output = {
    key: "device:" + "a".repeat(64),
    name: "Demo speakers",
    kind: "output",
    volume: 45,
    muted: false,
    isDefault: true,
  };
  const input = {
    key: "device:" + "b".repeat(64),
    name: "Demo microphone",
    kind: "input",
    volume: 80,
    muted: false,
    isDefault: true,
  };
  const app = {
    key: "app:" + "c".repeat(64),
    name: "Demo player",
    kind: "app",
    volume: 30,
    muted: false,
    sessions: 1,
    active: true,
  };
  const state = { available: true, output, input, devices: [output, input], apps: [app] },
    writes = [],
    media = [];
  const audio = createAudio({
    available: true,
    request: async (operation, payload) => {
      if (operation === "audio.set") {
        writes.push(payload);
        const row =
          payload.target === "system"
            ? output
            : payload.target === "microphone"
              ? input
              : state.apps.find((a) => a.key === payload.target);
        assert(row);
        if (payload.action === "volume") row.volume = payload.level;
        else row.muted = payload.action === "mute" ? payload.muted : !row.muted;
      }
      return structuredClone(state);
    },
  });
  const desktopActions = {
    audioStatus: audio.read,
    audioApply: audio.apply,
    refresh: audio.read,
    catalog: audio.catalog,
    execute: async (id, params) => {
      if (id.startsWith("native.audio.")) return audio.execute(id, params);
      assert.equal(id, "native.media");
      media.push(params.key);
      return { ok: true };
    },
    integrations: async () => ({ discord: { available: false } }),
    shutdown: audio.shutdown,
  };
  const core = createCore({
    runtimeDir,
    dryRun: true,
    desktopActions,
    fixtureSecretVaultOptions: require("./support/fixture-vault-codec.cjs"),
  });
  const server = await listen(core.app),
    reservation = await listen(http.createServer()),
    port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const local = "http://127.0.0.1:" + server.address().port;
  const enabled = await fetch(local + "/api/network-sharing", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Origin: local },
    body: JSON.stringify({ enabled: true, port }),
  });
  assert.equal(enabled.status, 200);
  const address =
    Object.values(os.networkInterfaces())
      .flat()
      .find((n) => n && n.family === "IPv4" && !n.internal)?.address || "127.0.0.1";
  const base = "http://" + address + ":" + port,
    browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await core.services.lifecycle.stopAll();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, hasTouch: true }),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.setDefaultTimeout(10000);
  await page.goto(base);
  await page.locator("#deckButtonMode").click();
  await page.locator('[data-deck-button="windows-controls"]').click();
  const panel = page.locator("#deckWindowsPanel");
  await panel.getByRole("slider", { name: "System audio volume", exact: true }).waitFor();
  assert.equal(writes.length, 0, "opening the popup is read-only");
  assert.equal(
    await panel.getByRole("slider", { name: "System audio volume", exact: true }).inputValue(),
    "45",
  );
  assert.equal(
    await panel.getByRole("link").count(),
    0,
    "the panel provides controls, not settings shortcuts",
  );
  const system = panel
    .locator(".deckWindowsAudioCard")
    .filter({ has: page.getByRole("slider", { name: "System audio volume", exact: true }) });
  await system.locator("summary").click();
  const pin = async (control) => {
    await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/control-deck" &&
          response.request().method() === "PUT" &&
          response.status() === 200,
      ),
      control.click(),
    ]);
  };
  await pin(system.getByRole("button", { name: "Pin volume slider", exact: true }));
  let config = (await (await fetch(local + "/api/control-deck")).json()).value.config;
  const volume = config.pages[0].buttons.find(
    (b) => b.steps[0]?.actionId === "native.audio.volume:system",
  );
  assert.equal(volume.kind, "slider");
  assert.equal(writes.length, 0, "pinning does not change volume");
  await panel.getByRole("button", { name: "Microphone", exact: true }).click();
  const microphone = panel
    .locator(".deckWindowsAudioCard")
    .filter({ has: page.getByRole("slider", { name: "Windows microphone volume", exact: true }) });
  await microphone.locator("summary").click();
  await pin(microphone.getByRole("button", { name: "Pin mute toggle", exact: true }));
  await panel.getByRole("button", { name: "Mute Windows microphone", exact: true }).click();
  await panel.getByRole("button", { name: "Unmute Windows microphone", exact: true }).waitFor();
  assert.equal(input.muted, true);
  await panel.getByRole("button", { name: "All audio", exact: true }).click();
  const appCard = panel
    .locator(".deckWindowsAudioCard")
    .filter({ has: page.getByRole("slider", { name: "Demo player volume", exact: true }) });
  await appCard.locator("summary").click();
  await pin(appCard.getByRole("button", { name: "Pin audio popup", exact: true }));
  config = (await (await fetch(local + "/api/control-deck")).json()).value.config;
  const popup = config.pages[0].buttons.find(
    (b) => b.steps[0]?.actionId === "native.audio.controls:" + app.key,
  );
  assert(popup);
  assert.equal(writes.length, 1, "pinning the app popup does not change audio");
  const slider = panel.getByRole("slider", { name: "System audio volume", exact: true });
  await slider.fill("0");
  await panel.getByText("Windows audio updated.", { exact: true }).waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector('#deckWindowsPanel input[aria-label="System audio volume"]').value ===
      "0",
  );
  assert(writes.some((w) => w.target === "system" && w.action === "volume" && w.level === 0));
  await panel.getByRole("button", { name: "⏯ Play / pause", exact: true }).click();
  await panel.getByText("Media command sent to Windows.", { exact: true }).waitFor();
  assert.deepEqual(media, ["playPause"]);
  const search = panel.getByRole("searchbox", { name: "Find app audio" });
  await search.fill("demo");
  output.muted = true;
  await audio.read(true);
  await panel.getByRole("button", { name: "Unmute System audio", exact: true }).waitFor();
  assert.equal(await search.inputValue(), "demo");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await panel.evaluate((e) => e.scrollWidth <= e.clientWidth + 1), true);
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await page.locator('[data-deck-button="' + popup.id + '"]').click();
  await panel.getByRole("slider", { name: "Demo player volume", exact: true }).waitFor();
  assert.equal(await panel.getByRole("slider").count(), 1);
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  const denied = await fetch(base + "/api/control-deck/windows/audio", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://untrusted.invalid" },
    body: JSON.stringify({ target: "system", action: "volume", level: 20 }),
  });
  assert.equal(denied.status, 403);
  const invalid = await fetch(base + "/api/control-deck/windows/audio", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({ target: "system", action: "volume", level: 101 }),
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(errors, []);
});
