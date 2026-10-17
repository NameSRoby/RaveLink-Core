const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const { chromium } = require("playwright");
const createCore = require("../src/app/core/create-core-server");
const extension = require("../src/app/optional/create-feature-platform-extension");
test("SoundCloud player imports public playlists, confirms PLAY, preserves FIFO, and moderates active tracks", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-soundcloud-"));
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
      soundcloudCatalogFetch: async (url) => {
        await new Promise((resolve) => setTimeout(resolve, 2700));
        const f = require("./support/soundcloud-catalog-fixture.cjs");
        return new Response(f.html(url.searchParams.get("q"), [f.track(3)]), {
          headers: { "content-type": "text/html" },
        });
      },
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
  await context.route("https://i1.sndcdn.com/**", (route) =>
    route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
        "base64",
      ),
    }),
  );
  await context.route("https://www.youtube.com/iframe_api", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 750));
    return route.fulfill({
      contentType: "application/javascript",
      body: "window.YT={PlayerState:{PLAYING:1,ENDED:0},Player:function(id,o){window.ytCreated=true;setTimeout(()=>o.events.onReady(),0);return {setVolume(){},pauseVideo(){},stopVideo(){},playVideo(){}}}};window.onYouTubeIframeAPIReady();",
    });
  });
  await context.route("https://w.soundcloud.com/player/?**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<p>SoundCloud fixture</p>",
    }),
  );
  await context.route("https://w.soundcloud.com/player/api.js", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `
    window.scInstances=[];window.scAutoPlay=false;
    const Events=Object.fromEntries(['READY','ERROR','PLAY','PAUSE','FINISH','PLAY_PROGRESS'].map(x=>[x,x]));
    function Widget(node){const handlers={},url=new URL(node.src).searchParams.get('url'),id=url.endsWith('/two')?'2':url.endsWith('/one')?'1':url.split('/').pop();
      const sound=id=>({id,title:'SC track '+id,duration:200000,policy:'ALLOW',album:'Fixture album',artwork_url:'https://i1.sndcdn.com/artworks-fixture-large.jpg',user:{username:'Uploader'}});
      const w={node,url,bind(e,f){handlers[e]=f;if(e==='READY')setTimeout(()=>f(),10)},unbind(e){delete handlers[e]},emit(e,data){handlers[e]?.(data||{})},
        getSounds(cb){cb(url.includes('/sets/')?[sound('10'),sound('11')]:[sound(id)])},setVolume(){},pause(){},play(){if(window.scAutoPlay)this.emit('PLAY')}};window.scInstances.push(w);return w;
    }Widget.Events=Events;window.SC={Widget};`,
    }),
  );
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (capability, method, payload = null) => {
    const reply = await fetch(base + "/api/features/song-request/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capability, method, payload, timeoutMs: 10000 }),
    });
    const result = await reply.json();
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.value || result.result || result;
  };
  await page.goto(base + "/features-ui/song-request/player");
  const surface = page.locator("#surface").contentFrame();
  await surface
    .locator('[data-choice-for="songPlayerProvider"] button:not([disabled])')
    .first()
    .waitFor();
  await surface
    .locator('[data-choice-for="songPlayerProvider"] [data-choice-value="soundcloud"]')
    .click();
  await surface.locator("#soundcloudPlayer").waitFor();
  assert.equal(await surface.locator("#youtubeEmbedWarning").isHidden(), true);
  assert.equal(await surface.locator("#soundcloudPlayer h2").innerText(), "SoundCloud");
  assert.equal(await surface.locator("#playerFrame").isHidden(), true);
  const knownIssues = surface.locator("#providerKnownIssues");
  assert.equal(await knownIssues.isVisible(), true);
  assert.equal(await knownIssues.getAttribute("open"), null);
  await knownIssues.locator("summary").click();
  assert.match(await knownIssues.innerText(), /rate limits/);
  assert.match(
    await knownIssues.locator("a").getAttribute("href"),
    /issues\/new\?template=bug_report.yml$/,
  );
  await knownIssues.locator("summary").click();
  await surface.locator("#videoInput").fill("https://example.com/evil");
  await surface.locator("#addSong").click();
  await surface
    .locator("#requestNotice")
    .filter({
      hasText: "Use a YouTube, Spotify, TIDAL, or public SoundCloud track link.",
    })
    .waitFor();
  for (const slug of ["one", "two"]) {
    await surface.locator("#videoInput").fill("https://soundcloud.com/artist/" + slug);
    await surface.locator("#addSong").click();
    await surface.locator("#requestNotice").filter({ hasText: "Queued SC track" }).waitFor();
  }
  const firstRequest = surface.locator("#queue tr").first();
  // The queued notice precedes the asynchronous queue render. Wait for the row
  // and inspect one DOM snapshot so a repaint cannot turn boundingBox into null.
  await firstRequest.waitFor({ state: "visible" });
  const rowHeight = await firstRequest.evaluate((row) => row.getBoundingClientRect().height);
  assert.ok(rowHeight > 0 && rowHeight < 110, "closed moderation must not stretch queue rows");
  assert.equal(
    await firstRequest.locator("details").count(),
    0,
    "moderation must be directly accessible",
  );
  assert.equal(await firstRequest.locator(".moderationGroup").count(), 2);
  assert.equal(
    await firstRequest.getByRole("button", { name: "BAN SONG", exact: true }).isVisible(),
    true,
  );
  await page.screenshot({
    path: path.join(__dirname, "../runtime/moderation-menu-desktop.png"),
    fullPage: true,
  });
  await surface.locator("#soundcloudStart").click();
  await page.waitForTimeout(800);
  assert.equal(
    await surface.locator("body").evaluate(() => Boolean(window.ytCreated)),
    false,
    "late YouTube SDK must not initialize the inactive player",
  );
  await surface.locator("#soundcloudState").filter({ hasText: "Loading SC track 1" }).waitFor();
  assert.equal(
    (await api("song.playback.read.v1", "status")).managed.status,
    "loading",
    "READY does not confirm playback",
  );
  await surface.locator("body").evaluate(() => {
    window.scAutoPlay = true;
    window.scInstances.at(-1).emit("PLAY");
  });
  await surface.locator("#soundcloudState").filter({ hasText: "Playing SC track 1" }).waitFor();
  await surface.locator("body").evaluate(() => window.scInstances.at(-1).emit("FINISH"));
  await surface.locator("#soundcloudState").filter({ hasText: "Playing SC track 2" }).waitFor();
  const sources = await context.newPage();
  await sources.goto(base + "/features-ui/song-request/now-playing");
  const observer = sources.locator("#surface").contentFrame();
  await observer.locator("[data-source=soundcloud][aria-pressed=true]").waitFor();
  assert.equal(await observer.locator("#observerControls").isHidden(), true);
  await observer.locator("#select").click();
  await observer
    .locator("#notice")
    .filter({ hasText: "SOUNDCLOUD is now the overlay source" })
    .waitFor();
  await observer.locator("#title").filter({ hasText: "SC track 2" }).waitFor();
  assert.equal(await observer.locator("#album").innerText(), "Fixture album");
  await observer.locator("#artwork").evaluate((image) => {
    if (!image.complete || !image.naturalWidth)
      throw new Error("SoundCloud source artwork did not load");
  });
  await observer.locator("#playbackTiming").filter({ hasText: "Playing" }).waitFor();
  await surface.locator("body").evaluate(() => window.scInstances.at(-1).emit("PAUSE"));
  await observer.locator("#playbackTiming").filter({ hasText: "Paused" }).waitFor();
  await surface.locator("body").evaluate(() => window.scInstances.at(-1).emit("PLAY"));
  await observer.locator("#playbackTiming").filter({ hasText: "Playing" }).waitFor();
  await created.extension.registry.request("song-request", "song.overlay.admin.v1", "configure", {
    config: require("../features/song-request/dist/overlay-presets").get("album-card"),
  });
  const obs = await context.newPage();
  await obs.goto(base + "/features-ui/song-request/obs-overlay");
  await obs
    .locator("#surface")
    .contentFrame()
    .locator("#stage")
    .filter({ hasText: "SC track 2" })
    .waitFor();
  await obs.locator("#surface").contentFrame().locator(".artwork img").waitFor();
  await sources.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await observer
      .locator("body")
      .evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true,
  );
  await obs.close();
  await sources.close();
  await surface.locator("#videoInput").fill("https://soundcloud.com/artist/one");
  await surface.locator("#addSong").click();
  await surface.locator("#requestNotice").filter({ hasText: "Queued SC track 1" }).waitFor();
  const replayed = surface.locator("#queue tr").filter({ hasText: "SC track 1" });
  await replayed.getByRole("button", { name: "REMOVE", exact: true }).click();
  await replayed.waitFor({ state: "detached" });
  const current = surface.locator("#soundcloudCurrentActions");
  await current.getByRole("button", { name: "TIMEOUT SONG", exact: true }).click();
  await surface.locator("#soundcloudState").filter({ hasText: "Waiting for requests" }).waitFor();
  await surface.locator("#videoInput").fill("https://soundcloud.com/artist/two");
  await surface.locator("#addSong").click();
  await surface
    .locator("#requestNotice")
    .filter({ hasText: "temporarily blocked by moderation" })
    .waitFor();
  await surface.locator("#videoInput").fill("Fixture Artist Query Song");
  await surface.locator("#addSong").click();
  await surface
    .locator("#requestNotice")
    .filter({ hasText: "Queued Query Song by Fixture Artist" })
    .waitFor({ timeout: 7000 })
    .catch(async () => {
      throw new Error(
        "Text search: " +
          (await surface.locator("#requestNotice").innerText()) +
          "; notice: " +
          (await surface.locator("#notice").innerText()),
      );
    });
  await surface.locator("#soundcloudState").filter({ hasText: "Playing Query Song" }).waitFor();
  assert.equal(await surface.locator(".now").isHidden(), true);
  assert.equal(await surface.locator("#soundcloudFrame iframe").count(), 1);
  await surface.locator("#soundcloudSkip").click();
  await surface.locator("#soundcloudState").filter({ hasText: "Waiting for requests" }).waitFor();
  await surface.getByRole("tab", { name: "Moderation", exact: true }).click();
  assert.equal(await surface.locator("#songSearchFilters").isVisible(), true);
  assert.equal(await surface.locator("#minimumViews").isHidden(), true);
  await surface.getByRole("tab", { name: "Setup", exact: true }).click();
  assert.equal(await surface.locator("#catalogSettings").isHidden(), true);
  assert.equal(await surface.locator("#tidalPlayer").isHidden(), true);
  await surface
    .locator("#soundcloudPlaylistUrl")
    .fill("https://soundcloud.com/artist/sets/background");
  await surface.locator("#soundcloudImport").click();
  await surface.locator("#soundcloudImportState").filter({ hasText: "Saved 2 tracks" }).waitFor();
  const library = await api("song.playlist.read.v1", "status");
  const list = library.collections.find((row) => row.provider === "soundcloud");
  assert.equal(list.count, 2);
  await api("song.playlist.admin.v1", "mutate", {
    action: "select",
    collectionId: list.id,
  });
  await api("song.queue.admin.v1", "moderate", { action: "playlist_play" });
  await surface.getByRole("tab", { name: "Playback", exact: true }).click();
  await surface.locator("#soundcloudState").filter({ hasText: "Playing SC track 10" }).waitFor();
  await page.screenshot({
    path: path.join(__dirname, "../runtime/soundcloud-player.png"),
    fullPage: true,
  });
  await surface
    .locator('[data-choice-for="songPlayerProvider"] [data-choice-value="youtube"]')
    .click();
  await surface
    .locator('[data-choice-for="songPlayerProvider"] [data-choice-value="youtube"]:not([disabled])')
    .waitFor();
  assert.equal(
    await surface.locator("body").evaluate(() => Boolean(window.ytCreated)),
    true,
    "returning to YouTube initializes its already loaded SDK",
  );
  await surface
    .locator('[data-choice-for="songPlayerProvider"] [data-choice-value="soundcloud"]')
    .click();
  await surface
    .locator(
      '[data-choice-for="songPlayerProvider"] [data-choice-value="soundcloud"]:not([disabled])',
    )
    .waitFor();
  await page.reload();
  await surface
    .locator('[data-choice-for="songPlayerProvider"] button:not([disabled])')
    .first()
    .waitFor();
  assert.equal(await surface.locator("#songPlayerProvider").inputValue(), "soundcloud");
  assert.equal(await surface.locator("#soundcloudPlayer").isVisible(), true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  assert.equal(
    await surface
      .locator("body")
      .evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true,
  );
  const tabBox = await surface.locator("#playerTab-player").boundingBox();
  assert.ok(tabBox.height < 60, "tabs must not stretch into empty space");
  await surface.getByRole("tab", { name: "Setup", exact: true }).click();
  assert.equal(
    await surface
      .locator("body")
      .evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true,
  );
  assert.deepEqual(errors, []);
});
