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
    // Clock behavior is independent of which information the preset includes.
    segments: presets.get("split-panels").segments.map((segment, index) => ({
      ...segment,
      blocks:
        index === 0 ? [...segment.blocks, { id: "test-clock", kind: "time" }] : segment.blocks,
    })),
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
  assert.ok(bounds.width <= config.width && bounds.height < 110, JSON.stringify(bounds));
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

test("accent sources follow server, custom, provider and artwork colors without stale cover updates", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<div id="stage"></div>');
  await page.addStyleTag({
    path: path.join(__dirname, "../features/song-request/ui/overlay-renderer.css"),
  });
  for (const file of ["overlay-palette.js", "overlay-renderer.js"])
    await page.addScriptTag({ path: path.join(__dirname, "../features/song-request/ui", file) });
  const config = presets.get("compact-countdown");
  await page.evaluate((config) => {
    window.config = structuredClone(config);
    config = window.config;
    config.colorFade = false;
    window.current = {
      status: "paused",
      positionMs: 84000,
      durationMs: 200000,
      candidate: {
        provider: "spotify",
        title: "A long track name that must remain readable",
        artists: ["Artist"],
      },
    };
    window.theme = { accent: "#12ab34", text: "#eaeaea", surface: "#121a2f", muted: "#96a5c7" };
    window.paint = () =>
      SongOverlayRenderer.render(
        document.getElementById("stage"),
        window.config,
        current,
        [],
        theme,
      );
    paint();
  }, config);
  const stage = page.locator("#stage");
  const accent = () => stage.evaluate((el) => el.style.getPropertyValue("--oaccent"));
  assert.equal(await accent(), "#12ab34");
  await page.evaluate(() => {
    theme.accent = "#5544ee";
    paint();
  });
  assert.equal(await accent(), "#5544ee", "server accent changes remain live");
  await page.evaluate(() => {
    config.accentSource = "custom";
    config.accent = "#eb5678";
    paint();
  });
  assert.equal(await accent(), "#eb5678");
  await page.evaluate(() => {
    config.accentSource = "provider";
    paint();
  });
  assert.equal(await accent(), "#6ed9aa");
  await page.evaluate(() => {
    const image = document.createElement("canvas");
    image.width = image.height = 32;
    image.getContext("2d").fillStyle = "#f05898";
    image.getContext("2d").fillRect(0, 0, 32, 32);
    current.candidate.artworkUrl = image.toDataURL();
    config.accentSource = "artwork";
    paint();
  });
  await page.waitForFunction(
    () => document.getElementById("stage").style.getPropertyValue("--oaccent") !== "#6ed9aa",
  );
  assert.match(await accent(), /^#[0-9a-f]{6}$/);
  assert.equal(
    await stage.evaluate((el) => el.style.getPropertyValue("--otext")),
    "#eaeaea",
    "artwork never overrides text contrast",
  );
  let release;
  const delayed = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("https://art.example/late.png", async (route) => {
    await delayed;
    await route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      headers: { "access-control-allow-origin": "*" },
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#2244ff"/></svg>',
    });
  });
  await page.evaluate(() => {
    current.candidate.artworkUrl = "https://art.example/late.png";
    paint();
  });
  await page.evaluate(() => {
    config.accentSource = "theme";
    theme.accent = "#aa2233";
    paint();
  });
  release();
  await page.waitForLoadState("networkidle");
  assert.equal(await accent(), "#aa2233", "late cover cannot overwrite the next color source");
  await page.evaluate(() => {
    config.colorFade = true;
    config.surfaceEffect = "glass";
    paint();
  });
  assert.ok(
    await stage.evaluate((el) => getComputedStyle(el).transitionProperty.includes("--oaccent")),
  );
  assert.notEqual(await stage.evaluate((el) => getComputedStyle(el).backgroundImage), "none");
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await stage.evaluate((el) => getComputedStyle(el).transitionDuration), "0s");
});
