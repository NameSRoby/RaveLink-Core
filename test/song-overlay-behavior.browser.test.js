const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path");
const { chromium } = require("playwright");
const { overlayFrom, DEFAULT_OVERLAY } = require("../features/song-request/dist/overlay-config");
const presets = require("../features/song-request/dist/overlay-presets");

test("OBS behavior follows pause duration across polls, resumes immediately, and keeps provider colors optional", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await page.setContent(
    "<style>" +
      fs.readFileSync(
        path.join(__dirname, "../features/song-request/ui/overlay-renderer.css"),
        "utf8",
      ) +
      '</style><div id="stage"></div><div id="preview"></div>',
  );
  await page.addScriptTag({
    path: path.join(__dirname, "../features/song-request/ui/overlay-renderer.js"),
  });
  const config = overlayFrom({
    ...presets.get("split-panels"),
    hidePaused: true,
    pauseHideSeconds: 5,
    providerColors: true,
    remainingTime: true,
  });
  await page.evaluate((config) => {
    window.config = config;
    window.current = {
      status: "playing",
      positionMs: 10000,
      durationMs: 180000,
      observedAt: Date.now(),
      candidate: {
        provider: "soundcloud",
        title: "Track title",
        artists: ["Artist"],
      },
    };
    window.paint = () =>
      SongOverlayRenderer.render(document.getElementById("stage"), window.config, window.current);
    paint();
  }, config);
  const stage = page.locator("#stage");
  assert.equal(await stage.evaluate((el) => el.style.getPropertyValue("--oaccent")), "#ff9655");
  const bounds = await stage.boundingBox();
  assert.ok(bounds.width <= 360 && bounds.height < 110, JSON.stringify(bounds));
  await page.clock.fastForward(45000);
  await stage.evaluate((el) => SongOverlayRenderer.update(el));
  assert.equal(await stage.locator(".playbackTime").textContent(), "-2:05 / 3:00");
  await page.evaluate(() => {
    current.status = "paused";
    current.positionMs = 55000;
    current.observedAt = Date.now();
    paint();
  });
  await page.clock.fastForward(4000);
  await stage.evaluate((el) => {
    current.observedAt = Date.now();
    SongOverlayRenderer.observe(el, config, current);
    SongOverlayRenderer.update(el);
  });
  assert.equal(
    await stage.getAttribute("aria-hidden"),
    "false",
    "periodic paused snapshots must preserve the pause start",
  );
  await page.clock.fastForward(1100);
  await stage.evaluate((el) => SongOverlayRenderer.update(el));
  assert.equal(await stage.getAttribute("aria-hidden"), "true");
  await page.evaluate(() => {
    current.status = "playing";
    current.observedAt = Date.now();
    paint();
  });
  assert.equal(await stage.getAttribute("aria-hidden"), "false");
  await page.evaluate(() => {
    current.status = "stopped";
    paint();
  });
  assert.equal(await stage.getAttribute("aria-hidden"), "false", "stopped hiding is opt-in");
  await page.evaluate(() => {
    config.hideStopped = true;
    paint();
  });
  assert.equal(await stage.getAttribute("aria-hidden"), "true");
  await page.evaluate(() => {
    current.status = "loading";
    config.hideLoading = true;
    paint();
  });
  assert.equal(await stage.getAttribute("aria-hidden"), "true");
  await page.evaluate(() => {
    current.status = "paused";
    SongOverlayRenderer.render(document.getElementById("preview"), config, current);
  });
  await page.clock.fastForward(6000);
  await page.locator("#preview").evaluate((el) => SongOverlayRenderer.update(el));
  assert.equal(
    await page.locator("#preview").getAttribute("aria-hidden"),
    "false",
    "editing preview stays visible until simulation is requested",
  );
  await page.evaluate(() => {
    config.hidePaused = false;
    config.providerColors = false;
    config.accent = "#123456";
    paint();
  });
  assert.equal(await stage.getAttribute("aria-hidden"), "false");
  assert.equal(await stage.evaluate((el) => el.style.getPropertyValue("--oaccent")), "#123456");
});

test("overlay behavior defaults, validation and saved profiles preserve explicit user choices", () => {
  const { createSongQueue } = require("../features/song-request/dist/domain");
  assert.equal(DEFAULT_OVERLAY.hidePaused, false);
  assert.equal(DEFAULT_OVERLAY.pauseHideSeconds, 5);
  const invalid = overlayFrom({
    ...DEFAULT_OVERLAY,
    hidePaused: "yes",
    providerColors: "yes",
    pauseHideSeconds: 500,
  });
  assert.equal(invalid.hidePaused, false);
  assert.equal(invalid.providerColors, false);
  assert.equal(invalid.pauseHideSeconds, 5);
  const q = createSongQueue(),
    config = {
      ...presets.get("classic"),
      hidePaused: true,
      pauseHideSeconds: 8,
      hideStopped: true,
      hideLoading: true,
      providerColors: true,
      remainingTime: true,
    };
  const saved = q.overlayProfile({
    action: "save",
    name: "Quiet overlay",
    config,
  });
  assert.equal(saved.ok, true);
  const restored = createSongQueue();
  assert.equal(restored.importSnapshot(q.exportSnapshot()).ok, true);
  const settings = restored.overlayProfile({
    action: "load",
    id: saved.profile.id,
  }).profile.config;
  for (const key of [
    "hidePaused",
    "pauseHideSeconds",
    "hideStopped",
    "hideLoading",
    "providerColors",
    "remainingTime",
  ])
    assert.equal(settings[key], config[key]);
});
