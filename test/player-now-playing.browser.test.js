const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const { chromium } = require("playwright");
const createCore = require("../src/app/core/create-core-server");
const extension = require("../src/app/optional/create-feature-platform-extension");
test("Now Playing shows local artwork, album, paused timing and a compact accessible fallback", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-now-playing-"));
  fs.cpSync(
    path.join(__dirname, "../features/song-request"),
    path.join(root, "installed/song-request"),
    { recursive: true },
  );
  const created = createCore({
    rootDir: path.join(__dirname, ".."),
    runtimeDir: path.join(root, "runtime"),
    dryRun: true,
    capabilities: { features: true },
    extend: extension({
      featuresRoot: path.join(root, "installed"),
      runtimeRoot: path.join(root, "features-runtime"),
      allowUnsafeRuntime: true,
    }),
  });
  await created.extension.startup;
  const server = await new Promise((resolve) => {
    const listener = created.app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await created.extension.shutdown();
    await created.services.lifecycle.stopAll();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  await context.route("https://www.youtube.com/iframe_api", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "" }),
  );
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/features-ui/song-request/player`);
  const surface = page.locator("#surface").contentFrame();
  await surface
    .locator('[data-choice-for="songPlayerProvider"] button:not([disabled])')
    .first()
    .waitFor();
  await surface
    .locator('[data-choice-for="songPlayerProvider"] [data-choice-value="tidal"]')
    .click();
  await surface.locator("body").evaluate(async () => {
    refreshState = async () => {};
    while (refreshing) await new Promise((resolve) => setTimeout(resolve, 10));
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 16;
    canvas.getContext("2d").fillRect(0, 0, 16, 16);
    window.cardArtwork = canvas.toDataURL("image/jpeg");
    window.cardState = {
      playbackSource: "tidal",
      primary: {
        provider: "tidal",
        title: "A detailed now playing track",
        artists: ["Recording artist"],
        album: "Album title",
        status: "paused",
        positionMs: 42000,
        durationMs: 180000,
        observedAt: Date.now(),
        artworkUrl: window.cardArtwork,
      },
    };
    renderPlayback(window.cardState);
  });
  await surface.locator("#nowArtwork:not([hidden])").waitFor();
  assert.equal(await surface.locator("#nowAlbum").innerText(), "Album title");
  // Windows can report the new title first, then replace the cover later.
  await surface.locator("body").evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 16;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#bd2538";
    ctx.fillRect(0, 0, 16, 16);
    window.nextCardArtwork = canvas.toDataURL("image/jpeg");
    window.changedCardState = {
      ...window.cardState,
      primary: {
        ...window.cardState.primary,
        title: "Next song",
        album: "Next album",
      },
    };
    renderPlayback(window.changedCardState);
  });
  assert.equal(await surface.locator("#nowTitle").innerText(), "Next song");
  await surface.locator("body").evaluate(() =>
    renderPlayback({
      ...window.changedCardState,
      primary: {
        ...window.changedCardState.primary,
        artworkUrl: window.nextCardArtwork,
      },
    }),
  );
  await surface.locator("#nowArtwork:not([hidden])").waitFor();
  assert.equal(
    await surface.locator("#nowArtwork").getAttribute("src"),
    await surface.locator("body").evaluate(() => window.nextCardArtwork),
    "a late thumbnail replaces the previous cover without another title change",
  );
  await surface.locator("body").evaluate(() => renderPlayback(window.cardState));
  await surface.locator("#nowArtwork:not([hidden])").waitFor();
  assert.equal(await surface.locator("#nowPlaybackState").innerText(), "Paused");
  assert.equal(await surface.locator("#nowElapsed").innerText(), "0:42");
  assert.equal(await surface.locator("#nowDuration").innerText(), "3:00");
  assert.equal(await surface.locator("#nowArtwork").getAttribute("alt"), "Cover for Album title");
  await page.waitForTimeout(1100);
  assert.equal(
    await surface.locator("#nowElapsed").innerText(),
    "0:42",
    "paused clock must remain still",
  );
  await page.screenshot({
    path: path.join(__dirname, "../runtime/now-playing-detail.png"),
    fullPage: true,
  });
  await surface.locator("body").evaluate(() =>
    renderPlayback({
      ...window.cardState,
      primary: {
        ...window.cardState.primary,
        status: "playing",
        positionMs: 12000,
        observedAt: Date.now() - 45000,
      },
    }),
  );
  assert.equal(
    await surface.locator("#nowElapsed").innerText(),
    "0:57",
    "playing progress continues past 15 seconds between observations",
  );
  await surface.locator("body").evaluate(() =>
    renderPlayback({
      ...window.cardState,
      primary: {
        ...window.cardState.primary,
        status: "paused",
        positionMs: 9000,
        observedAt: Date.now(),
      },
    }),
  );
  assert.equal(
    await surface.locator("#nowElapsed").innerText(),
    "0:09",
    "a new paused or seek position replaces the extrapolated clock",
  );
  await surface.locator("body").evaluate(() =>
    renderPlayback({
      ...window.cardState,
      primary: {
        ...window.cardState.primary,
        artworkUrl: "",
        album: "",
        title: "Artwork unavailable",
      },
    }),
  );
  assert.equal(await surface.locator("#nowArtwork").isHidden(), true);
  assert.equal(await surface.locator("#nowAlbum").isHidden(), true);
  const spotifyCover = "https://i.scdn.co/image/" + "a".repeat(40);
  const bytes = await surface.locator("body").evaluate(() => window.cardArtwork.split(",")[1]);
  await context.route(spotifyCover, (route) =>
    route.fulfill({
      contentType: "image/jpeg",
      body: Buffer.from(bytes, "base64"),
    }),
  );
  await surface.locator("body").evaluate((body, url) => {
    $("songPlayerProvider").value = "spotify";
    renderPlayback({
      playbackSource: "spotify",
      primary: {
        provider: "spotify",
        title: "Spotify cover",
        album: "Spotify album",
        artists: ["Artist"],
        status: "paused",
        artworkUrl: url,
      },
    });
  }, spotifyCover);
  await surface.locator("#nowArtwork:not([hidden])").waitFor();
  assert.equal(
    await surface.locator("#nowArtwork").getAttribute("src"),
    spotifyCover,
    "Spotify CDN cover is allowed by the contribution CSP",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  assert.equal(
    await surface
      .locator("body")
      .evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true,
  );
  await surface
    .locator("body")
    .evaluate(() => renderPlayback({ playbackSource: "tidal", primary: null }));
  assert.equal(await surface.locator("#nowTimeline").isHidden(), true);
  assert.equal(await surface.locator("#nowPlaybackState").innerText(), "Nothing playing");
});
