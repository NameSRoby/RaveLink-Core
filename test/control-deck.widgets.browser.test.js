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
test("LAN status widgets add, customize, reorder and remove independently; song clocks stay local and timestamps remain real", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rvl-widget-ui-")),
    start = Date.now() - 600000;
  let remoteMarkers = 0,
    streamReads = 0;
  const media = {
    queue: {
      paused: false,
      counts: { queued: 2 },
      queue: [
        {
          id: "playing",
          candidate: { title: "Fixture song", artists: ["Band"] },
          requesterLabel: "Viewer A",
        },
        {
          id: "next",
          candidate: { title: "Next request", artists: ["Next band"] },
          requesterLabel: "Viewer B",
        },
      ],
    },
    playback: {
      managed: { entryId: "playing" },
      primary: {
        provider: "youtube",
        title: "Fixture song",
        artists: ["Band"],
        requesterLabel: "Viewer A",
        leaseId: "private-lease",
        status: "playing",
        durationMs: 180000,
        positionMs: 10000,
        observedAt: Date.now(),
      },
    },
  };
  const provider = {
    status: () => ({
      connected: true,
      userId: "123",
      scopes: ["channel:read:subscriptions", "channel:manage:broadcast"],
      accessToken: "private-token",
    }),
    dashboardStream: async () => {
      streamReads++;
      return {
        ok: true,
        live: true,
        id: "456",
        startedAt: start,
        title: "Fixture stream",
        category: "Game",
        viewers: 123,
      };
    },
    dashboardFollowers: async () => ({
      ok: true,
      total: 2000,
      recent: [{ name: "Follower", at: Date.now() }],
    }),
    dashboardSubscribers: async () => ({ ok: true, total: 50, points: 75 }),
    dashboardVod: async () => ({ ok: true, videos: [{ streamId: "456", videoId: "999" }] }),
    dashboardClips: async () => ({
      ok: true,
      count: 1,
      complete: true,
      recent: [
        {
          id: "FixtureClip",
          title: "A great play",
          creator: "Clipper",
          url: "https://clips.twitch.tv/FixtureClip",
          at: Date.now(),
        },
      ],
    }),
    createStreamMarker: async () => {
      remoteMarkers++;
      return { ok: true, id: "marker", positionSeconds: 600, createdAt: Date.now() };
    },
  };
  const obs = {
    connection: { connected: true },
    streaming: true,
    recording: false,
    program: "Gameplay",
    stats: { fps: 60, cpu: 3 },
    streamTiming: {
      startedAt: start,
      durationMs: 600000,
      observedAt: Date.now(),
      frames: 10000,
      dropped: 0,
    },
  };
  const core = createCore({
    runtimeDir: root,
    dryRun: true,
    desktopActions: {
      catalog: () => [],
      refresh: async () => {},
      shutdown() {},
      integrations: async () => ({ discord: { available: false } }),
    },
    deckWidgetOptions: { getProvider: () => provider, getMedia: () => media, getObs: () => obs },
  });
  const server = await listen(core.app),
    reservation = await listen(http.createServer()),
    port = reservation.address().port;
  await new Promise((r) => reservation.close(r));
  const local = "http://127.0.0.1:" + server.address().port,
    address =
      Object.values(os.networkInterfaces())
        .flat()
        .find((r) => r && r.family === "IPv4" && !r.internal)?.address || "127.0.0.1",
    base = "http://" + address + ":" + port;
  assert.equal(
    (
      await fetch(local + "/api/network-sharing", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Origin: local },
        body: JSON.stringify({ enabled: true, port }),
      })
    ).status,
    200,
  );
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await core.services.lifecycle.stopAll();
    await new Promise((r) => server.close(r));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } }),
    errors = [],
    requests = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => requests.push({ url: new URL(r.url()).pathname, method: r.method() }));
  await page.goto(base, { waitUntil: "domcontentloaded" });
  media.playback.primary.artworkUrl = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    c.getContext("2d").fillRect(0, 0, 64, 64);
    return c.toDataURL("image/jpeg");
  });
  await page.locator("#deckButtonMode").click();
  assert(await page.locator(".deckWidgetRegion").isHidden());
  await page.locator("#deckEdit").click();
  await page.getByLabel("Widget starter set", { exact: true }).selectOption("music");
  const playing = page.locator('[data-widget-type="now-playing"]');
  await playing.getByText("Fixture song", { exact: true }).waitFor();
  await playing.getByText("Requested by Viewer A", { exact: true }).waitFor();
  await playing.getByText(/Next: Next request · Viewer B/).waitFor();
  const requester = page.locator('[data-widget-type="queue"]'),
    nextRequest = page.locator('[data-widget-type="next-request"]');
  await requester.locator(".deckWidgetMain").filter({ hasText: "Viewer A" }).waitFor();
  assert.equal(await requester.locator("progress").isVisible(), false);
  assert.equal(await requester.locator("img").isVisible(), false);
  assert.equal(await requester.getByText("Fixture song", { exact: true }).count(), 0);
  await nextRequest.locator(".deckWidgetMain").filter({ hasText: "Next request" }).waitFor();
  await nextRequest.getByText("Requested by Viewer B", { exact: true }).waitFor();
  const upcoming = media.queue.queue.pop();
  await nextRequest.locator(".deckWidgetMain").filter({ hasText: "No song" }).waitFor();
  media.queue.queue.push(upcoming);
  await nextRequest.locator(".deckWidgetMain").filter({ hasText: "Next request" }).waitFor();
  assert(await playing.locator("img").evaluate((e) => e.complete && e.naturalWidth > 0));
  const before = await playing.locator("progress").evaluate((e) => e.value),
    requestCount = requests.filter((r) => r.url === "/api/control-deck/state").length;
  await page.waitForTimeout(1300);
  assert((await playing.locator("progress").evaluate((e) => e.value)) > before + 500);
  assert.equal(
    requests.filter((r) => r.url === "/api/control-deck/state").length,
    requestCount,
    "song clocks do not poll the API",
  );
  await playing.getByRole("button", { name: "Edit", exact: true }).click();
  const edit = page.locator("#deckWidgetEditor");
  await edit.getByLabel("Custom title (optional)", { exact: true }).fill("My music");
  assert((await edit.boundingBox()).width <= 900);
  assert.equal(
    await edit
      .getByLabel("Show cover art", { exact: true })
      .evaluate((el) => getComputedStyle(el).width),
    "16px",
  );
  await edit.locator(".deckWidgetPreview h3").filter({ hasText: "My music" }).waitFor();
  await edit.getByLabel("Accent / backlight color", { exact: true }).fill("#123456");
  await edit.getByLabel("Width (columns)", { exact: true }).fill("2");
  await edit.getByLabel("Show cover art", { exact: true }).uncheck();
  await edit.getByLabel("Show who requested it", { exact: true }).uncheck();
  await edit.getByRole("button", { name: "Save widget", exact: true }).click();
  await edit.waitFor({ state: "hidden" });
  await playing.getByText("My music", { exact: true }).waitFor();
  assert(await playing.locator("img").isHidden());
  assert.equal(await playing.getByText("Requested by Viewer A", { exact: true }).count(), 0);
  await page.getByLabel("Maximum widgets per row", { exact: true }).selectOption("2");
  await page.getByLabel("Widget starter set", { exact: true }).selectOption("stream");
  await page
    .locator('[data-widget-type="audience"]')
    .getByText(/123 watching.*2000 followers.*50 subs/)
    .waitFor();
  await page
    .locator('[data-widget-type="clips"]')
    .getByText("A great play", { exact: true })
    .waitFor();
  assert.match(
    await page.locator('[data-widget-type="stream"] .deckWidgetMain').textContent(),
    /Live/,
  );
  assert.match(await page.locator('[data-widget-type="obs"]').textContent(), /Gameplay/);
  await page.getByRole("button", { name: "+ Add widget", exact: true }).click();
  await edit.getByLabel("Widget", { exact: true }).selectOption("clock");
  await edit.getByRole("button", { name: "Save widget", exact: true }).click();
  await edit.waitFor({ state: "hidden" });
  const clock = page.locator('[data-widget-type="clock"]');
  await clock.getByRole("button", { name: "Move Clock earlier", exact: true }).click();
  let config = (await (await fetch(local + "/api/control-deck")).json()).value.config;
  assert.equal(config.widgets.items.at(-2).type, "clock");
  await page.getByRole("button", { name: "Remove Recent clips", exact: true }).click();
  await page.locator('[data-widget-type="clips"]').waitFor({ state: "detached" });
  assert.equal(
    await page.getByRole("checkbox", { name: "Show in fullscreen", exact: true }).isChecked(),
    true,
  );
  await page.locator("#deckEdit").click();
  const markers = page.locator('[data-widget-type="markers"]');
  await markers.locator("summary").click();
  await markers.getByLabel("Timestamp description", { exact: true }).fill("Great play");
  await markers.getByRole("button", { name: "+ Mark moment", exact: true }).click();
  await markers.locator(".deckWidgetMain").filter({ hasText: "Great play" }).waitFor();
  assert.equal(remoteMarkers, 0);
  const state = (await (await fetch(local + "/api/control-deck")).json()).value;
  assert(!JSON.stringify(state.widgetData).includes("private-"));
  const moments = (await (await fetch(local + "/api/control-deck/timestamps")).json()).value.items;
  assert.equal(moments.length, 1);
  assert.match(moments[0].url, /videos\/999\?t=/);
  const download = page.waitForEvent("download");
  await markers.locator("summary").click();
  await markers.getByRole("button", { name: "Export", exact: true }).click();
  assert.equal((await download).suggestedFilename(), "RaveLink-stream-timestamps.txt");
  const reads = streamReads;
  await page.waitForTimeout(1200);
  assert.equal(streamReads, reads, "idle widget screens reuse the Twitch cache");
  const current = (await (await fetch(local + "/api/control-deck")).json()).value;
  current.config.pages[0].buttons.push({
    id: "moment-button",
    title: "Mark stream",
    kind: "macro",
    steps: [{ actionId: "stream.timestamp", params: { description: "Macro moment" } }],
    appearance: { symbol: "\u2691" },
  });
  const savedButton = await fetch(local + "/api/control-deck", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Origin: local },
    body: JSON.stringify({ revision: current.revision, value: current.config }),
  });
  assert.equal(savedButton.status, 200);
  await page.waitForTimeout(400);
  await page.locator('[data-deck-button="moment-button"]').click();
  await markers.locator(".deckWidgetMain").filter({ hasText: "Macro moment" }).waitFor();
  assert.equal(remoteMarkers, 0);
  assert.equal(
    (await (await fetch(local + "/api/control-deck/timestamps")).json()).value.items.length,
    2,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector(".deckWidgetGrid")).gridTemplateColumns.split(" ")
        .length === 1,
  );
  assert(
    await page.locator(".deckWidgetRegion").evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
  );
  await page
    .locator(".deckWidgetRegion")
    .screenshot({ path: path.resolve("runtime/status-widgets-phone-private.png") });
  await page.evaluate(() => {
    document.querySelector("#controlDeck").requestFullscreen = undefined;
  });
  await page.locator("#deckFocus").click();
  assert.equal(await page.locator(".deckWidgetRegion").isVisible(), true);
  const widgetBounds = await page.locator(".deckWidgetRegion").boundingBox();
  const gridBounds = await page.locator("#deckGrid").boundingBox();
  assert(
    widgetBounds.y + widgetBounds.height <= gridBounds.y + 1,
    "fullscreen keeps widgets above buttons",
  );
  assert.equal(await page.locator(".deckToolbar").isVisible(), false);
  await page.keyboard.press("Escape");
  assert.deepEqual(errors, []);
});
