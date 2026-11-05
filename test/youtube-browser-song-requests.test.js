const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const { chromium } = require("playwright");
const createCore = require("../src/app/core/create-core-server");
const createExtension = require("../src/app/optional/create-feature-platform-extension");
const fixture = require("./support/youtube-browser-fixture.cjs");
const waitFor = async (predicate) => {
  const deadline = Date.now() + 12000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw Error("fixture_condition_timeout");
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
};
test("optional browser UI delivers requests through the supervised feature, confirms playback rewards and refunds exact pre-play removal", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "youtube-browser-workflow-"));
  const features = path.join(root, "features");
  fs.cpSync(path.join(__dirname, "../features/song-request"), path.join(features, "song-request"), {
    recursive: true,
  });
  const outcomes = [];
  let id = 0;
  const created = createCore({
    rootDir: path.join(__dirname, ".."),
    runtimeDir: path.join(root, "runtime"),
    dryRun: true,
    capabilities: { features: true },
    extend: createExtension({
      featuresRoot: features,
      runtimeRoot: path.join(root, "feature-runtime"),
      allowUnsafeRuntime: true,
      youtubeBrowser: { buildExtensions: false },
      providers: {
        "youtube.catalog.host.v1/status": () => ({ ok: true, configured: true, mode: "keyless" }),
        "youtube.browser.host.v1/resolve": ({ query }) => ({
          ok: true,
          candidate: {
            provider: "youtube",
            providerItemId: ["ccccccccccc", "ddddddddddd", "eeeeeeeeeee"][id++],
            title: query,
            artists: ["Demo artist"],
            durationMs: 180000,
          },
        }),
        "twitch.rewards.manage.v1/song-outcome": (payload) => {
          outcomes.push(payload);
          return { ok: true };
        },
      },
    }),
  });
  await created.extension.startup;
  const server = await new Promise((resolve) => {
    const listener = created.app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const browser = await chromium.launch({ headless: true });
  let peer;
  t.after(async () => {
    await browser.close();
    await peer?.close();
    await created.extension.shutdown();
    await created.services.lifecycle.stopAll();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const request = async (capability, method, payload) => {
    const result = await created.extension.registry.request(
      "song-request",
      capability,
      method,
      payload,
      { timeoutMs: 20000 },
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.value;
  };
  const context = await browser.newContext();
  await context.route("https://www.youtube.com/iframe_api", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `window.YT={PlayerState:{PLAYING:1,ENDED:0},Player:function(id,options){const api={setVolume(){},pauseVideo(){},stopVideo(){},loadVideoById(){window.fixtureEmbedLoads=(window.fixtureEmbedLoads||0)+1;}};setTimeout(()=>options.events.onReady(),0);return api;}};window.onYouTubeIframeAPIReady();`,
    }),
  );
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/features-ui/song-request/player`);
  const surface = page.locator("#surface").contentFrame();
  await surface.getByRole("tab", { name: "Setup", exact: true }).click();
  await surface.locator("#youtubePlaybackMode").selectOption("browser");
  await waitFor(
    async () =>
      (await request("song.player.preferences.v1", "status", null)).youtubePlayback === "browser",
  );
  assert.equal(
    (
      await request("song.playback.driver.v1", "pull", {
        driverId: "stale-embed",
        providers: ["youtube"],
      })
    ).action,
    null,
  );
  peer = await fixture({
    handle: (method, payload) => request("song.youtube.browser.v1", method, payload),
  });
  await surface.locator("#enableYoutubeBrowser").click();
  await waitFor(async () => Boolean(await surface.locator("#youtubeBrowserCode").inputValue()));
  await surface.getByRole("tab", { name: "Playback", exact: true }).click();
  assert.equal(await surface.locator("#playerFrame").isHidden(), true);
  await surface.locator("#videoInput").fill("First browser request");
  await surface.locator("#addSong").click();
  await waitFor(() => peer.commands.some((command) => command.videoId === "ccccccccccc"));
  await waitFor(() => peer.rows.some((row) => row.videoId === "ccccccccccc"));
  const submit = (payload) => request("song.queue.submit.v1", "submit", payload);
  const first = await submit({
    requestId: "reward-browser-play",
    query: "Reward browser request",
    requesterId: "viewer-a",
    requesterName: "Demo viewer",
    requesterRole: "viewer",
    rewardRedemption: true,
    notifyChat: false,
  });
  assert.equal(first.ok, true);
  await waitFor(() => peer.rows.some((row) => row.videoId === "ddddddddddd"));
  assert.equal(outcomes.length, 0, "queue handoff is not playback");
  const native = (await request("song.youtube.browser.v1", "status", null)).handoffs.find(
    (row) => row.entryId === first.entry.id,
  );
  assert(native?.uid);
  peer.play(native.uid);
  await waitFor(() =>
    outcomes.some((row) => row.requestId === "reward-browser-play" && row.status === "FULFILLED"),
  );
  const second = await submit({
    requestId: "reward-browser-remove",
    query: "Remove before playback",
    requesterId: "viewer-b",
    requesterName: "Another demo viewer",
    requesterRole: "viewer",
    rewardRedemption: true,
    notifyChat: false,
  });
  assert.equal(second.ok, true);
  await waitFor(() => peer.rows.some((row) => row.videoId === "eeeeeeeeeee"));
  const removed = await request("song.queue.submit.v1", "self", {
    action: "remove",
    requesterId: "viewer-b",
    requesterName: "Another demo viewer",
  });
  assert.equal(removed.ok, true, JSON.stringify(removed));
  await waitFor(() =>
    outcomes.some((row) => row.requestId === "reward-browser-remove" && row.status === "CANCELED"),
  );
  assert.equal(
    peer.rows.some((row) => row.videoId === "eeeeeeeeeee"),
    false,
  );
  assert.equal(peer.rows.at(-1).occurrenceId, "native:personal");
  assert.deepEqual(errors, []);
});
