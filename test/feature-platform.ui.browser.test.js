const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const createCoreServer = require("../src/app/core/create-core-server");
const createFeaturePlatformExtension = require("../src/app/optional/create-feature-platform-extension");
const unicodeTitle = "美波 - カワキヲアメク — a deliberately long title that must keep scrolling without restarting";

test("Features HUD lazy-loads integrity-checked Song Request player and overlay pages", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-feature-ui-"));
  const installed = path.join(root, "installed", "song-request");
  fs.cpSync(path.join(__dirname, "..", "features", "song-request"), installed, { recursive: true });
  const created = createCoreServer({
    rootDir: path.join(__dirname, ".."), runtimeDir: path.join(root, "runtime"), dryRun: true,
    capabilities: { features: true },
    extend: createFeaturePlatformExtension({
      featuresRoot: path.join(root, "installed"), runtimeRoot: path.join(root, "runtime", "features"), allowUnsafeRuntime: true,
      providers: {
        "youtube.catalog.host.v1/status": async () => ({ ok: true, configured: true, mode: "keyless" }),
        "youtube.catalog.host.v1/resolve": async payload => ({ ok: true, candidate: { provider: "youtube", providerItemId: payload.videoId || "M7lc1UVf-VE", title: unicodeTitle, artists: ["美波 / Minami"], durationMs: 285920 } })
      }
    })
  });
  await created.extension.startup;
  const server = await new Promise(resolve => {
    const listener = created.app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await created.extension.shutdown();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let streamConnections = 0;
  server.on('request', (req, res) => {
    if (req.url !== '/api/features-stream') return;
    streamConnections++;
    res.on('close', () => { streamConnections--; });
  });
  const snapshot = await fetch(`${base}/api/features`).then(response => response.json());
  const deniedStream = await fetch(`${base}/api/features-stream`, { headers: { origin: 'https://untrusted.invalid' } });
  assert.equal(deniedStream.status, 403);
  assert.equal(snapshot.features[0].uiContributions.length, 5);
  assert.deepEqual(snapshot.features[0].uiContributions.map(row => row.surface), ["panel", "panel", "panel", "overlay", "panel"]);
  assert.equal((await fetch(`${base}/health`).then(response => response.json())).capabilities.songRequest, true);
  const playerResponse = await fetch(`${base}/features-ui/song-request/player`);
  assert.equal(playerResponse.status, 200);
  for (const pageId of ["request-queue", "server-playlist"]) {
    const response = await fetch(`${base}/features-ui/song-request/${pageId}`);
    assert.equal(response.status, 200);
  }
  assert.match(playerResponse.headers.get("content-security-policy"), /frame-src 'self'/);
  assert.match(playerResponse.headers.get("content-security-policy"), /connect-src 'self'/);
  const contentResponse = await fetch(`${base}/features-content/song-request/player`);
  assert.equal(contentResponse.status, 200);
  assert.equal(contentResponse.headers.get("referrer-policy"), "origin");
  assert.match(contentResponse.headers.get("content-security-policy"), /script-src 'unsafe-inline' https:\/\/www\.youtube\.com/);
  assert.match(contentResponse.headers.get("content-security-policy"), /connect-src 'none'/);
  assert.match(contentResponse.headers.get("content-security-policy"), /sandbox allow-scripts allow-presentation allow-same-origin/);
  const overlayContent = await fetch(`${base}/features-content/song-request/obs-overlay`);
  assert.equal(overlayContent.headers.get("referrer-policy"), "no-referrer");
  assert.match(overlayContent.headers.get("content-security-policy"), /img-src data: https:\/\/i\.ytimg\.com/);
  assert.doesNotMatch(overlayContent.headers.get("content-security-policy"), /allow-same-origin/);
  async function featureCall(capability, method, payload) {
    const response = await fetch(`${base}/api/features/song-request/call`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ capability, method, payload })
    });
    const body = await response.json();
    assert.equal(response.ok, true, JSON.stringify(body));
    return body.value;
  }
  await featureCall("song.queue.submit.v1", "submit", {
    requestId: "ui-playback", requesterId: "viewer", query: "Blood and Guts",
    candidate: { provider: "youtube", providerItemId: "M7lc1UVf-VE", title: unicodeTitle, artists: ["美波 / Minami"], durationMs: 285920 }
  });
  await featureCall("song.queue.admin.v1", "moderate", { action: "playback_start" });
  const playbackLease = (await featureCall("song.playback.driver.v1", "pull", { driverId: "ui-test", providers: ["youtube"] })).action;
  await featureCall("song.playback.driver.v1", "acknowledge", { driverId: "ui-test", leaseId: playbackLease.leaseId, state: "started", positionMs: 20000, durationMs: 285920 });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.route("https://www.youtube.com/**", route => route.abort());
  const page = await context.newPage();
  const contributionRequests = [];
  page.on("request", request => { if (request.url().includes("/features-ui/")) contributionRequests.push(request.url()); });
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.locator("#featuresTab").waitFor({ state: "visible" });
  await page.locator("#featuresTab").click();
  await page.getByRole("button", { name: "Player" }).waitFor();
  assert.deepEqual(contributionRequests, []);
  const originalPageCount = context.pages().length;
  await page.getByRole("button", { name: "Player" }).click();
  await page.locator('[data-panel="feature:song-request"] iframe').waitFor();
  assert.equal(context.pages().length, originalPageCount);
  const popup = await context.newPage();
  await popup.goto(`${base}/features-ui/song-request/player`);
  await popup.waitForLoadState("domcontentloaded");
  const playerSurface = popup.locator("#surface").contentFrame();
  await playerSurface.locator("#playerFrame").waitFor();
  const box = await playerSurface.locator("#playerFrame").boundingBox();
  assert.ok(box.width >= 480);
  assert.ok(box.height >= 270);
  assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true);
  const queuePopup = await context.newPage();
  await queuePopup.goto(`${base}/features-ui/song-request/request-queue`, { waitUntil: "domcontentloaded" });
  const queueSurface = queuePopup.locator("#surface").contentFrame();
  await queueSurface.locator("#queue").waitFor();
  await queueSurface.getByRole("button", { name: "Previous" }).waitFor();
  await queueSurface.getByRole("button", { name: "Next" }).waitFor();
  assert.equal(await queueSurface.locator("body").evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true);
  const playlistPopup = await context.newPage();
  await playlistPopup.goto(`${base}/features-ui/song-request/server-playlist`, { waitUntil: "domcontentloaded" });
  const playlistSurface = playlistPopup.locator("#surface").contentFrame();
  await playlistSurface.locator("#playlist").waitFor();
  await playlistSurface.getByRole("button", { name: "Play" }).waitFor();
  await playlistSurface.getByRole("button", { name: "Shuffle" }).waitFor();
  await playlistSurface.getByRole("button", { name: "Import" }).waitFor();
  await playlistSurface.locator("#collections").waitFor();
  assert.equal(await playlistSurface.locator("body").evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true);
  if (process.env.RAVELINK_CAPTURE_UI === '1') {
    const output = path.join(__dirname, '..', 'runtime', 'logs');
    fs.mkdirSync(output, { recursive: true });
    await queuePopup.screenshot({ path: path.join(output, 'song-request-request-queue-desktop.png'), fullPage: true });
    await playlistPopup.screenshot({ path: path.join(output, 'song-request-server-playlist-desktop.png'), fullPage: true });
  }
  await queuePopup.close();
  await playlistPopup.close();
  await playerSurface.locator('#catalogSettings summary').click();
  assert.equal(await playerSurface.locator('#derivativeFilters input').count(), 18);
  assert.equal(await playerSurface.locator('#minimumSubscribers').inputValue(), '100000');
  assert.equal(await playerSurface.locator('#minimumViews').inputValue(), '50000');
  assert.equal(await playerSurface.locator('#allowNonMusic').isChecked(), false);
  assert.equal(await playerSurface.locator('#catalogMode').inputValue(), 'keyless');
  assert.equal(await playerSurface.locator('#officialKeyField').isHidden(), true);
  assert.equal(await playerSurface.locator('#minimumSubscribers').isDisabled(), true);
  await playerSurface.locator('#catalogSettings').evaluate(details => { details.open = false; });
  await playerSurface.locator('#catalogSettings summary').click();
  await playerSurface.locator('#derivativeFilters input[data-derivative="cover"]').uncheck();
  await playerSurface.locator('#saveCatalogPolicy').click();
  await playerSurface.locator('#notice').filter({ hasText: 'YouTube search filters saved' }).waitFor();
  await playerSurface.locator("body").evaluate(() => call("lighting.output.v1", "apply", {}).catch(error => { document.body.dataset.denied = error.message; }));
  await playerSurface.locator('body[data-denied="capability_denied"]').waitFor();
  await page.locator('#featuresTab').click();
  await page.locator('#featureRows [data-page-id="overlay-editor"]').click();
  await page.locator('[data-panel="feature:song-request"] iframe:visible').contentFrame().locator('#surface').contentFrame().locator('#workspace').waitFor();
  assert.equal(context.pages().length, originalPageCount + 1);
  const editorPopup = await context.newPage();
  await editorPopup.goto(`${base}/features-ui/song-request/overlay-editor`);
  await editorPopup.waitForLoadState("domcontentloaded");
  const editorSurface = editorPopup.locator("#surface").contentFrame();
  await editorSurface.locator("#workspace .segment").first().waitFor();
  assert.equal(await editorSurface.locator("#workspace .segment").count(), 1);
  await editorSurface.locator("#separated").check();
  await editorSurface.locator("#preview.separated").waitFor();
  await editorSurface.locator("#heightMode").selectOption("fixed");
  await editorSurface.locator("#height").evaluate(input => { input.value = "180"; input.dispatchEvent(new Event("input", { bubbles: true })); });
  await editorSurface.locator("#preview.height-fixed").waitFor();
  assert.equal(await editorSurface.locator("#heightOut").textContent(), "180px");
  const firstPiece = editorSurface.locator("#workspace .piece").first();
  await firstPiece.locator('button[title="Format this information piece"]').click();
  const blockFormat = firstPiece.locator(".format-tray");
  await blockFormat.locator("select").nth(0).selectOption("display");
  await blockFormat.locator("select").nth(1).selectOption("serif");
  await blockFormat.locator(".checks input").nth(1).check();
  const formattedLabel = editorSurface.locator("#preview .pv.label");
  assert.equal(await formattedLabel.evaluate(el => getComputedStyle(el).fontSize), "27px");
  assert.match(await formattedLabel.evaluate(el => getComputedStyle(el).fontFamily), /Georgia/);
  await editorSurface.locator('.segment-head button[title="Format this segment"]').first().click();
  await editorSurface.locator(".segment-style").first().locator("input[type=checkbox]").check();
  assert.equal(await editorSurface.locator("#preview .preview-segment").first().evaluate(el => getComputedStyle(el).backgroundColor), "rgba(5, 7, 12, 0.78)");
  await editorSurface.locator("#save").click();
  await editorSurface.locator("#status").filter({ hasText: "Overlay saved" }).waitFor();
  await editorSurface.locator("#addSegment").click();
  await editorSurface.locator("#palette .piece").nth(1).dragTo(editorSurface.locator("#workspace .dropzone").nth(1));
  assert.equal(await editorSurface.locator("#workspace .segment").count(), 2);
  assert.equal(await editorSurface.locator("#workspace .dropzone").nth(1).locator(".piece").count(), 1);
  await editorPopup.waitForFunction(() => sessionStorage.getItem('ravelink-ui-draft-v1:song-request:overlay-editor') !== null);
  editorPopup.once('dialog', dialog => dialog.accept());
  await editorPopup.reload();
  await editorSurface.locator('#status').filter({ hasText: 'Unsaved draft recovered' }).waitFor();
  assert.equal(await editorSurface.locator('#workspace .segment').count(), 2);
  await editorPopup.setViewportSize({ width: 390, height: 844 });
  assert.equal(await editorSurface.locator('body').evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true);
  if (process.env.RAVELINK_CAPTURE_UI === '1') {
    const output = path.join(__dirname, '..', 'runtime', 'logs');
    fs.mkdirSync(output, { recursive: true });
    await editorPopup.screenshot({ path: path.join(output, 'overlay-draft-mobile.png'), fullPage: true });
  }
  await editorPopup.setViewportSize({ width: 1280, height: 800 });
  await editorSurface.locator("#reset").click();
  await editorSurface.locator("#save").click();
  await editorSurface.locator("#status").filter({ hasText: "Overlay saved" }).waitFor();
  await page.locator('[data-tab="feature:song-request"]').click();
  if (process.env.RAVELINK_CAPTURE_UI === '1') {
    const output = path.join(__dirname, '..', 'runtime', 'logs');
    await popup.screenshot({ path: path.join(output, 'song-request-player-desktop.png'), fullPage: true });
    await editorPopup.screenshot({ path: path.join(output, 'song-request-overlay-designer.png'), fullPage: true });
  }
  await popup.close();
  await editorPopup.close();
  const workspace = page.locator('[data-panel="feature:song-request"]');
  await workspace.locator('iframe').first().waitFor({ state: 'attached' });
  const embeddedPlayer = workspace.locator('iframe').first();
  await workspace.getByRole('button', { name: 'Player', exact: true }).click();
  const embeddedPlayerSurface = embeddedPlayer.contentFrame().locator('#surface').contentFrame();
  await embeddedPlayerSurface.locator('#playerFrame').waitFor();
  assert.equal(await embeddedPlayerSurface.locator('#responseToggles input').count(), 20);
  await embeddedPlayerSurface.locator('details', { has: embeddedPlayerSurface.locator('#responseToggles') }).locator('summary').click();
  await embeddedPlayerSurface.locator('[data-response="queued"]').check();
  await embeddedPlayerSurface.locator('#saveResponses').click();
  await embeddedPlayerSurface.locator('#notice').filter({ hasText: 'Native Twitch chat responses saved' }).waitFor();
  await embeddedPlayer.evaluate(frame => { frame.dataset.preserved = 'yes'; });
  await workspace.getByRole('button', { name: 'Overlay Designer', exact: true }).click();
  const designer = workspace.locator('iframe:visible').contentFrame().locator('#surface').contentFrame();
  await designer.locator('#workspace .segment').waitFor();
  await designer.locator('html.native-feature').waitFor();
  const wrapper = workspace.locator('iframe:visible').contentFrame();
  await wrapper.locator('#surface').evaluate(async surface => {
    await new Promise(resolve => {
      const transparent = value => value === 'rgba(0, 0, 0, 0)';
      const check = () => {
        if (transparent(getComputedStyle(document.documentElement).backgroundColor)
          && transparent(getComputedStyle(document.body).backgroundColor)
          && transparent(getComputedStyle(surface).backgroundColor)) resolve();
        else requestAnimationFrame(check);
      };
      check();
    });
  });
  assert.equal(await designer.locator('header h1').isVisible(), false);
  await page.evaluate(() => document.documentElement.style.setProperty('--accent', '#228866'));
  await designer.locator('html').evaluate(async () => {
    await new Promise(resolve => {
      const check = () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === '#228866' ? resolve() : requestAnimationFrame(check);
      check();
    });
  });
  await workspace.getByRole('button', { name: 'Player', exact: true }).click();
  await embeddedPlayer.contentFrame().locator('#surface').contentFrame().locator('#openOverlay').click();
  await workspace.locator('[data-page="obs-overlay"].active').waitFor();
  await workspace.locator('.overlaySourceTools').waitFor({ state: 'visible' });
  assert.equal(await workspace.locator('.overlaySourceTools input').first().inputValue(), `${base}/features-ui/song-request/obs-overlay?v=0.13.7`);
  assert.equal(await workspace.locator('.overlaySourceTools input').nth(1).inputValue(), '360 x 150');
  const compactOverlay = await context.newPage();
  await compactOverlay.addInitScript(() => {
    Object.defineProperty(window, 'SharedWorker', { value: undefined });
    Object.defineProperty(window, 'EventSource', { value: class { addEventListener() {} close() {} } });
  });
  await compactOverlay.setViewportSize({ width: 360, height: 150 });
  await compactOverlay.goto(`${base}/features-ui/song-request/obs-overlay`, { waitUntil: 'domcontentloaded' });
  const compactSurface = compactOverlay.locator('#surface').contentFrame();
  const compactStage = compactSurface.locator('#stage:not(.hidden)');
  await compactStage.waitFor();
  const compactVisual = await compactStage.evaluate(stage => {
    const body = getComputedStyle(document.body);
    const style = getComputedStyle(stage);
    const title = stage.querySelector('h1');
    const box = stage.getBoundingClientRect();
    return { bodyBackground: body.backgroundColor, stageBackground: style.backgroundColor, colorScheme: getComputedStyle(document.documentElement).colorScheme, titleSize: title ? getComputedStyle(title).fontSize : '', width: box.width, height: box.height, left: box.left, top: box.top };
  });
  assert.equal(compactVisual.bodyBackground, 'rgba(0, 0, 0, 0)');
  assert.equal(compactVisual.stageBackground, 'rgba(5, 7, 12, 0.78)');
  assert.equal(compactVisual.colorScheme, 'normal');
  assert.equal(compactVisual.titleSize, '21px');
  assert.ok(compactVisual.width <= 336 && compactVisual.height <= 126, JSON.stringify(compactVisual));
  assert.ok(compactVisual.left >= 12 && compactVisual.top >= 12, JSON.stringify(compactVisual));
  const marquee = compactSurface.locator('.titleViewport.scrolling');
  await marquee.waitFor();
  assert.equal(await marquee.locator('h1').count(), 2);
  assert.equal(await marquee.locator('h1').first().textContent(), unicodeTitle);
  assert.equal(await marquee.evaluate(el => getComputedStyle(el).overflowX), 'hidden');
  assert.equal(await marquee.locator('.marqueeTrack').evaluate(el => getComputedStyle(el).animationName), 'ticker');
  const marqueeTransform = await marquee.locator('.marqueeTrack').evaluate(el => getComputedStyle(el).transform);
  await compactOverlay.waitForTimeout(350);
  assert.notEqual(await marquee.locator('.marqueeTrack').evaluate(el => getComputedStyle(el).transform), marqueeTransform);
  const timer = compactSurface.locator('.playbackTime');
  const progress = compactSurface.locator('.playbackProgress');
  const timerBefore = await timer.textContent();
  const progressBefore = Number.parseFloat(await progress.evaluate(el => el.style.width));
  await compactOverlay.waitForTimeout(1300);
  assert.notEqual(await timer.textContent(), timerBefore);
  assert.ok(Number.parseFloat(await progress.evaluate(el => el.style.width)) > progressBefore);
  await progress.evaluate(el => { window.__ravelinkProgressNode = el; window.__ravelinkMarqueeNode = document.querySelector('.marqueeTrack'); window.__ravelinkMarqueeTime = window.__ravelinkMarqueeNode.getAnimations()[0].currentTime; });
  await featureCall("song.playback.driver.v1", "acknowledge", { driverId: "ui-test", leaseId: playbackLease.leaseId, state: "progress", positionMs: 22000, durationMs: 285920 });
  await compactOverlay.waitForTimeout(2200);
  assert.equal(await compactSurface.locator('.playbackProgress').evaluate(el => el === window.__ravelinkProgressNode), true);
  assert.equal(await compactSurface.locator('.marqueeTrack').evaluate(el => el === window.__ravelinkMarqueeNode), true);
  assert.equal(await compactSurface.locator('.marqueeTrack').evaluate(el => el.getAnimations()[0].currentTime > window.__ravelinkMarqueeTime), true);
  await compactOverlay.close();
  assert.equal(context.pages().length, originalPageCount);
  await workspace.getByRole('button', { name: 'Overlay Designer', exact: true }).click();
  await designer.locator('#addSegment').click();
  const draftKey = 'ravelink-ui-draft-v1:song-request:overlay-editor';
  await page.waitForFunction(key => sessionStorage.getItem(key) !== null, draftKey);
  await workspace.getByRole('button', { name: 'Player', exact: true }).click();
  assert.equal(await embeddedPlayer.getAttribute('data-preserved'), 'yes');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true);
  await workspace.getByRole('button', { name: 'Overlay Designer', exact: true }).click();
  await page.waitForFunction(() => {
    const frame = document.querySelector('.featurePageFrame:not([hidden])');
    return Number.parseInt(frame.style.height, 10) > 844;
  });
  if (process.env.RAVELINK_CAPTURE_UI === '1') await page.screenshot({ path: path.join(__dirname, '..', 'runtime', 'logs', 'native-feature-mobile.png'), fullPage: true });
  await page.locator('#featuresTab').click();
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('[data-feature-toggle="song-request"]').click();
  assert.equal(created.extension.registry.list().features[0].lifecycle, 'active');
  await fetch(`${base}/api/features/song-request/disable`, { method: 'POST' });
  await workspace.getByText('INSTALLED-DISABLED', { exact: true }).waitFor({ state: 'attached' });
  assert.equal(await workspace.locator('iframe').count(), 0);
  await fetch(`${base}/api/features/song-request/enable`, { method: 'POST' });
  await page.locator('[data-tab="feature:song-request"]').click();
  await workspace.locator('iframe').waitFor();
  await workspace.getByRole('button', { name: 'Overlay Designer', exact: true }).click();
  await designer.locator('#status').filter({ hasText: 'Draft recovered' }).waitFor();
  assert.equal(await designer.locator('#workspace .segment').count(), 2);
  const activePid = created.extension.registry.list().features[0].pid;
  process.kill(activePid);
  await workspace.getByText('CRASHED', { exact: true }).waitFor();
  assert.equal(await workspace.locator('iframe').count(), 0);
  await fetch(`${base}/api/features/song-request/restart`, { method: 'POST' });
  await workspace.locator('iframe').waitFor();
  await workspace.getByRole('button', { name: 'Overlay Designer', exact: true }).click();
  await designer.locator('#status').filter({ hasText: 'Draft recovered' }).waitFor();
  assert.equal(await designer.locator('#workspace .segment').count(), 2);
  await designer.locator('#discard').click();
  await designer.locator('#status').filter({ hasText: 'Draft discarded' }).waitFor();
  await page.waitForFunction(key => sessionStorage.getItem(key) === null, draftKey);
  assert.equal(await designer.locator('#workspace .segment').count(), 1);
  await designer.locator('#addSegment').click();
  await page.waitForFunction(key => sessionStorage.getItem(key) !== null, draftKey);
  await designer.locator('#save').click();
  await designer.locator('#status').filter({ hasText: 'Overlay saved' }).waitFor();
  await page.waitForFunction(key => sessionStorage.getItem(key) === null, draftKey);
  if (process.env.RAVELINK_CAPTURE_UI === "1") {
    const output = path.join(__dirname, "..", "runtime", "logs");
    fs.mkdirSync(output, { recursive: true });
    const mobile = await context.newPage();
    await mobile.setViewportSize({ width: 390, height: 844 });
    await mobile.goto(`${base}/features-ui/song-request/player`, { waitUntil: "domcontentloaded" });
    await mobile.screenshot({ path: path.join(output, "song-request-player-mobile.png"), fullPage: true });
    await mobile.close();
    const overlay = await context.newPage();
    await overlay.setViewportSize({ width: 1280, height: 720 });
    await overlay.goto(`${base}/features-ui/song-request/obs-overlay`, { waitUntil: "domcontentloaded" });
    const overlayState = await overlay.locator('#surface').contentFrame().locator('body').evaluate(async () => {
      try { return await call('song.playback.read.v1', 'status', null); }
      catch (error) { return { error: error.message }; }
    });
    assert.ok(overlayState.primary, JSON.stringify(overlayState));
    await overlay.locator("#surface").contentFrame().locator("#stage:not(.hidden)").waitFor();
    await overlay.screenshot({ path: path.join(output, "song-request-obs-overlay.png") });
  }
  const manyViews = [];
  for (let i = 0; i < 8; i++) {
    const view = await context.newPage();
    await view.goto(`${base}/features-ui/song-request/player`, { waitUntil: 'domcontentloaded' });
    await view.locator('#surface').contentFrame().locator('#connection').filter({ hasText: /^CONNECTED$/ }).waitFor();
    manyViews.push(view);
  }
  assert.equal(streamConnections, 1, 'all HUD and standalone views share one upstream connection');
  for (const view of manyViews) await view.locator('#surface').contentFrame().locator('#nowTitle').waitFor();
  for (const view of manyViews) await view.close();
  assert.equal(streamConnections, 1);
  await context.close();
  for (let i = 0; streamConnections && i < 50; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(streamConnections, 0, 'closing the final client releases its upstream connection');
  const fallbackContext = await browser.newContext();
  assert.equal(created.extension.registry.list().features[0].lifecycle, 'active', created.extension.registry.list().features[0].error);
  await fallbackContext.addInitScript(() => { window.SharedWorker = undefined; });
  await fallbackContext.route('https://www.youtube.com/**', route => route.abort());
  const fallbackHud = await fallbackContext.newPage();
  fallbackHud.on('pageerror', error => t.diagnostic(`Fallback page error: ${error.message}`));
  await fallbackHud.goto(base);
  await fallbackHud.locator('[data-tab="feature:song-request"]').click();
  const fallbackWorkspace = fallbackHud.locator('[data-panel="feature:song-request"]');
  await fallbackWorkspace.locator('iframe').contentFrame().locator('#surface').contentFrame().locator('#connection').filter({ hasText: /^CONNECTED$/ }).waitFor({ timeout: 5000 });
  await fallbackWorkspace.getByRole('button', { name: 'Overlay Designer', exact: true }).click();
  await fallbackWorkspace.locator('iframe:visible').contentFrame().locator('#surface').contentFrame().locator('#workspace .segment').first().waitFor();
  assert.equal(streamConnections, 1, 'workerless native subtabs share their HUD connection');
  await fallbackContext.close();
  for (let i = 0; streamConnections && i < 50; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(streamConnections, 0);
});
