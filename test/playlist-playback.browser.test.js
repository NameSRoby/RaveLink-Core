const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { chromium } = require("playwright");
const createCore = require("../src/app/core/create-core-server");
const extension = require("../src/app/optional/create-feature-platform-extension");
test("Library starts SoundCloud cold/warm and standalone YouTube without a second click", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-library-start-"));
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
    const s = created.app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const browser = await chromium.launch({ headless: true }),
    context = await browser.newContext();
  t.after(async () => {
    await browser.close();
    await created.extension.shutdown();
    await created.services.lifecycle.stopAll();
    await new Promise((r) => server.close(r));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = "http://127.0.0.1:" + server.address().port;
  const api = async (capability, method, payload = null) => {
    const result = await created.extension.registry.request(
      "song-request",
      capability,
      method,
      payload,
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.value;
  };
  await api("song.player.preferences.v1", "select", { player: "soundcloud" });
  const upload = await api("song.soundcloud.player.v1", "import-start", {
    name: "Library start fixture",
  });
  await api("song.soundcloud.player.v1", "import-append", {
    uploadId: upload.uploadId,
    offset: 0,
    sounds: [
      {
        id: 987,
        title: "Fixture song",
        duration: 180000,
        policy: "ALLOW",
        permalink_url: "https://soundcloud.com/artist/song",
        user: { username: "Artist" },
      },
    ],
  });
  const saved = await api("song.soundcloud.player.v1", "import-save", {
    uploadId: upload.uploadId,
  });
  await api("song.playlist.admin.v1", "mutate", {
    action: "select",
    collectionId: saved.collectionId,
  });
  await context.route("https://w.soundcloud.com/player/?**", (r) =>
    r.fulfill({ contentType: "text/html", body: "<p>Fixture</p>" }),
  );
  await context.route("https://w.soundcloud.com/player/api.js", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: `window.fixturePlays=0;const Events={READY:'ready',PLAY:'play',PAUSE:'pause',ERROR:'error',FINISH:'finish',PLAY_PROGRESS:'progress'};function Widget(){const h={};return{bind(e,f){h[e]=f;if(e==='ready')setTimeout(f,10)},unbind(){},setVolume(){},pause(){h.pause?.()},play(){window.fixturePlays++;h.play?.()},getCurrentSound(f){f({id:987})}}}Widget.Events=Events;window.SC={Widget};`,
    }),
  );
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  const directLibrary = page.locator(
    '[data-feature-page="song-request"][data-page-id="server-playlist"]',
  );
  await directLibrary.waitFor({ state: "attached" });
  // Enter the package manager before using its contribution button, as a user
  // does. Clicking a hidden manager row bypasses browser readiness/actionability.
  await page.locator('[data-tab="features"]').evaluate((button) => button.click());
  await directLibrary.click();
  assert.equal(
    await page.locator('iframe[title="Song Request: Player"]').count(),
    0,
    "Library can open before the Player has ever loaded",
  );
  const library = page
    .locator('iframe[title="Song Request: Playlists & Transfers"]')
    .contentFrame()
    .locator("#surface")
    .contentFrame();
  await library.locator("#play:not([disabled])").waitFor();
  await library.locator("#play").click();
  const player = page
    .locator('iframe[title="Song Request: Player"]')
    .contentFrame()
    .locator("#surface")
    .contentFrame();
  await player
    .locator("#soundcloudState")
    .filter({ hasText: "Playing Fixture song" })
    .waitFor({ timeout: 12000 });
  assert.equal((await api("song.playback.read.v1", "status")).managed.status, "playing");
  for (const button of ["shuffle", "random"]) {
    await player.locator("#soundcloudPause").click();
    await page.locator('[data-page="server-playlist"]').click();
    await library.locator("#" + button).click();
    await player.locator("#soundcloudState").filter({ hasText: "Playing Fixture song" }).waitFor();
  }
  // Separate rapid synthetic playback events from the import batch; keep the production IPC guard intact.
  await page.waitForTimeout(1000);
  const transfer = (payload) => api("song.playlist.transfer.v1", "action", payload);
  await transfer({ action: "upload_begin", name: "YouTube start fixture" });
  await transfer({
    action: "upload_chunk",
    offset: 0,
    chunk: "title,artists,source_provider,source_id\nYouTube fixture,Artist,youtube,abcdefghijk",
  });
  const preview = await transfer({ action: "preview_csv" });
  await transfer({ action: "save_local", jobId: preview.job.id });
  const libraryState = await api("song.playlist.read.v1", "status", {
    limit: 1,
  });
  const youtube = libraryState.collections.find((row) => row.name === "YouTube start fixture");
  assert.ok(youtube);
  await api("song.playlist.admin.v1", "mutate", {
    action: "select",
    collectionId: youtube.id,
  });
  await context.route("https://www.youtube.com/iframe_api", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: `window.YT={PlayerState:{PLAYING:1,ENDED:0},Player:function(id,o){setTimeout(()=>o.events.onReady(),20);return{setVolume(){},pauseVideo(){},stopVideo(){},playVideo(){o.events.onStateChange({data:1})},loadVideoById(){o.events.onStateChange({data:1})}}}};window.onYouTubeIframeAPIReady();`,
    }),
  );
  await page.close();
  const standalone = await context.newPage();
  standalone.on("pageerror", (e) => errors.push(e.message));
  await standalone.goto(base + "/features-ui/song-request/server-playlist");
  await standalone.locator("#surface").contentFrame().locator("#play:not([disabled])").click();
  await standalone.waitForURL((url) => url.pathname === "/features-ui/song-request/player");
  const yt = standalone.locator("#surface").contentFrame();
  await yt
    .locator("#nowTitle")
    .filter({ hasText: "YouTube fixture" })
    .waitFor({ timeout: 15000 })
    .catch(async () => {
      throw new Error(
        JSON.stringify({
          errors,
          notice: await yt.locator("#notice").textContent(),
          provider: await yt.locator("#songPlayerProvider").inputValue(),
          playback: await api("song.playback.read.v1", "status"),
        }),
      );
    });
  assert.equal(await yt.locator("#songPlayerProvider").inputValue(), "youtube");
  assert.equal((await api("song.playback.read.v1", "status")).managed.status, "playing");
  assert.equal(
    new URL(standalone.url()).searchParams.has("startPlayback"),
    false,
    "start command is consumed rather than repeated on reload",
  );
  assert.deepEqual(errors, []);
});
