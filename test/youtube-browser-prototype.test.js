const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  vm = require("node:vm");
const createBridge = require("../integrations/youtube-browser/bridge.cjs");
const { build } = require("../scripts/build-youtube-browser");
const { chromium, firefox } = require("playwright");
const extension = path.resolve(__dirname, "../integrations/youtube-browser/extension");
const observation = () => ({
  current: { videoId: "aaaaaaaaaaa", title: "Song", artist: "Artist" },
  paused: false,
  mediaReady: true,
  nextAvailable: true,
  position: 10,
  duration: 180,
  volume: 50,
  queue: [{ videoId: "bbbbbbbbbbb", title: "Next" }],
});

test("loaded Chromium extension exchanges observations and confirms a console control end to end", async (t) => {
  const f = await fixture(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-youtube-extension-"));
  const folders = build(path.join(root, "extension"));
  const context = await chromium.launchPersistentContext(path.join(root, "profile"), {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${folders[1]}`, `--load-extension=${folders[1]}`],
  });
  t.after(async () => {
    await context.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  if (!context.serviceWorkers()[0]) await context.waitForEvent("serviceworker");
  // A local silent WAV supplies a real media element in both execution worlds.
  // Overriding HTMLMediaElement methods in the page would not test the isolated
  // content script, and no real provider playback is needed for this smoke test.
  const wav = Buffer.alloc(8044, 128);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(8036, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(8000, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(8000, 40);
  await context.route("https://music.youtube.com/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><ytmusic-player-bar><a class="title" href="/watch?v=aaaaaaaaaaa">Extension fixture</a><span class="byline">Artist</span></ytmusic-player-bar><ytmusic-player><video preload="auto" src="data:audio/wav;base64,${wav.toString("base64")}"></video></ytmusic-player>`,
    }),
  );
  const music = await context.newPage();
  await music.goto("https://music.youtube.com/watch?v=aaaaaaaaaaa");
  await music.waitForFunction(() => document.querySelector("video").readyState >= 1);
  const connectPage = await context.newPage();
  await connectPage.goto(`${f.connection.base}/connect.html#${f.connection.token}`);
  await connectPage.locator("#connectMusicTab").waitFor();
  await connectPage.waitForFunction(() => !document.querySelector("#connectMusicTab").disabled);
  assert.equal(new URL(connectPage.url()).hash, "", "the extension clears the private fragment");
  assert.equal(f.bridge.status().paired, false, "listing music tabs does not pair automatically");
  await connectPage.locator("#connectMusicTab").click();
  await connectPage.waitForFunction(() =>
    document.querySelector("#pairingStatus").textContent.startsWith("Connected."),
  );
  const consolePage = await context.newPage();
  await consolePage.goto(`${f.connection.base}/#${f.connection.token}`);
  await consolePage.waitForFunction(() =>
    document.querySelector("#connection").textContent.includes("fresh observation"),
  );
  assert.equal(new URL(consolePage.url()).hash, "", "pairing fragment is removed immediately");
  assert.equal(await consolePage.locator("#song").textContent(), "Extension fixture");
  await consolePage.locator('[data-action="pause"]').click();
  await consolePage.waitForFunction(
    () => document.querySelector("#result").textContent === "Confirmed by the player.",
  );
  assert.equal(f.bridge.status().lastCommand.ok, true);
  await consolePage.route("**/api/control", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "autoplay_blocked" }),
    }),
  );
  await consolePage.locator('[data-action="resume"]').click();
  await consolePage.waitForFunction(() =>
    document.querySelector("#result").textContent.includes("Click Play in YouTube Music once"),
  );
  await consolePage.unroute("**/api/control");
  const second = await context.newPage();
  await second.goto("https://music.youtube.com/watch?v=bbbbbbbbbbb");
  await second.waitForTimeout(1800);
  assert.equal(
    f.bridge.status().snapshot.current.videoId,
    "aaaaaaaaaaa",
    "an unselected second tab cannot replace the owner",
  );
});
async function fixture(t, options = {}) {
  const bridge = createBridge(options),
    connection = await bridge.listen(0);
  t.after(() => bridge.close());
  const request = async (route, body, headers = {}) => {
    const response = await fetch(`${connection.base}/api/${route}`, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${connection.token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return {
      status: response.status,
      data: response.headers.get("content-type")?.includes("application/json")
        ? await response.json()
        : null,
    };
  };
  return { bridge, connection, request };
}
test("browser bridge requires pairing, rejects web origins and locks to one tab owner", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("status", null, { Authorization: "Bearer wrong" })).status, 401);
  assert.equal((await f.request("status", null, { Origin: "https://evil.example" })).status, 403);
  const badHostStatus = await new Promise((resolve, reject) => {
    const request = require("node:http").get(
      f.connection.base + "/api/status",
      {
        headers: { Host: "evil.example", Authorization: `Bearer ${f.connection.token}` },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.on("error", reject);
  });
  assert.equal(badHostStatus, 403);
  const body = { clientId: "one", snapshot: observation() };
  assert.equal((await f.request("pair", { clientId: "one" })).status, 200);
  assert.equal(
    (await f.request("exchange", body, { Origin: "moz-extension://fixture" })).status,
    200,
  );
  assert.equal((await f.request("exchange", { ...body, clientId: "two" })).status, 409);
  const status = (await f.request("status")).data;
  assert.equal(status.fresh, true);
  assert.equal(status.snapshot.queueComplete, false);
  assert.equal(status.capabilities.append, false);
  assert.doesNotMatch(JSON.stringify(status), new RegExp(f.connection.token));
  assert.equal((await f.request("disconnect", { clientId: "two" })).status, 409);
  assert.equal((await f.request("disconnect", { clientId: "one" })).status, 200);
  assert.equal(f.bridge.status().connected, false);
  assert.equal((await f.request("exchange", { ...body, clientId: "one" })).status, 409);
  assert.equal((await f.request("pair", { clientId: "two" })).status, 200);
  assert.equal((await f.request("exchange", { ...body, clientId: "two" })).status, 200);
});
test("commands execute once, preserve uncertain outcomes and reject changed payloads/current songs", async (t) => {
  const f = await fixture(t, { timeoutMs: 150 });
  await f.request("pair", { clientId: "one" });
  const exchange = (result) =>
    f.request("exchange", { clientId: "one", snapshot: observation(), result });
  await exchange();
  assert.equal(
    (await f.request("control", { id: "bad", action: "skip", expectedVideoId: "bbbbbbbbbbb" }))
      .status,
    409,
  );
  const payload = { id: "skip-once", action: "skip", expectedVideoId: "aaaaaaaaaaa" };
  const pending = f.request("control", payload);
  let issued;
  for (let i = 0; i < 30 && !issued; i++) {
    issued = (await exchange()).data.command;
    if (!issued) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(issued.id, payload.id);
  assert.equal((await exchange()).data.command, null, "an issued action is not leased twice");
  const result = { id: issued.id, sessionId: issued.sessionId, ok: true };
  assert.equal((await exchange(result)).data.ack, issued.id);
  assert.deepEqual((await pending).data, { ok: true });
  assert.deepEqual((await f.request("control", payload)).data, { ok: true });
  assert.equal((await f.request("control", { ...payload, action: "pause" })).status, 409);
  const unknown = f.request("control", { ...payload, id: "lost-ack" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const command = (await exchange()).data.command;
  assert.equal(command.id, "lost-ack");
  assert.equal((await unknown).data.error, "control_unconfirmed");
  assert.equal((await exchange()).data.command, null);
});
test("stale observations disable controls, hostile metadata is bounded, and ads block skip", async (t) => {
  let clock = 1000;
  const f = await fixture(t, { now: () => clock });
  await f.request("pair", { clientId: "one" });
  const value = observation();
  value.current.title = "<script>" + "x".repeat(500);
  value.queue = Array.from({ length: 200 }, () => ({ videoId: "bbbbbbbbbbb", title: "Next" }));
  value.queue[0] = { title: "A row without a link", artist: "Artist" };
  await f.request("exchange", { clientId: "one", snapshot: value });
  let state = f.bridge.status();
  assert.ok(state.snapshot.current.title.length <= 180);
  assert.doesNotMatch(state.snapshot.current.title, /[<>]/);
  assert.equal(state.snapshot.queue.length, 100);
  assert.equal(state.snapshot.queue[0].videoId, null);
  assert.equal(state.snapshot.queue[0].identityAvailable, false);
  clock += 16000;
  state = f.bridge.status();
  assert.equal(state.connected, true);
  assert.equal(state.fresh, false);
  assert.equal(
    (await f.request("control", { id: "stale", action: "pause", expectedVideoId: "aaaaaaaaaaa" }))
      .status,
    409,
  );
  clock += 30000;
  assert.equal(f.bridge.status().connected, false);
  value.ad = true;
  await f.request("exchange", { clientId: "one", snapshot: value });
  assert.equal(
    (await f.request("control", { id: "ad", action: "skip", expectedVideoId: "aaaaaaaaaaa" })).data
      .error,
    "unsupported_control",
  );
});
test("Firefox and Chromium bundles share source and request no cookie or all-site permissions", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-youtube-build-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folders = build(root);
  const manifests = folders.map((folder) =>
    JSON.parse(fs.readFileSync(path.join(folder, "manifest.json"))),
  );
  assert.deepEqual(manifests[0].background, { scripts: ["native-service.js", "background.js"] });
  assert.deepEqual(manifests[1].background, { service_worker: "background.js" });
  for (const manifest of manifests) {
    assert.deepEqual(manifest.permissions, ["storage", "activeTab", "scripting"]);
    assert.equal(manifest.content_scripts[0].all_frames, false);
    assert.equal(manifest.host_permissions.length, 2);
  }
  assert.equal(
    fs.readFileSync(path.join(folders[0], "background.js"), "utf8"),
    fs.readFileSync(path.join(folders[1], "background.js"), "utf8"),
  );
});
for (const family of ["browser", "chrome"]) {
  test(`${family} background restricts pairing to its popup or authenticated local page and keeps credentials out of music pages`, async (t) => {
    const f = await fixture(t);
    const local = {},
      session = {};
    const storage = (values) => ({
      get: async (key) => ({ [key]: values[key] }),
      set: async (input) => Object.assign(values, input),
      remove: async (key) => {
        delete values[key];
      },
    });
    let handler;
    const popupUrl = `${family === "browser" ? "moz" : "chrome"}-extension://fixture/popup.html`;
    const api = {
      runtime: {
        id: "fixture",
        getURL: () => popupUrl,
        onMessage: {
          addListener: (fn) => {
            handler = fn;
          },
        },
      },
      storage: { local: storage(local), session: storage(session) },
      tabs: {
        get: async (id) => ({ id, url: "https://music.youtube.com/watch?v=aaaaaaaaaaa" }),
        query: async () => [{ id: 7, url: "https://music.youtube.com/watch?v=aaaaaaaaaaa" }],
        sendMessage: async () => {},
      },
    };
    const sandbox = {
      URL,
      [family]: api,
      crypto: require("node:crypto").webcrypto,
      fetch,
      AbortSignal,
    };
    vm.runInNewContext(fs.readFileSync(path.join(extension, "background.js"), "utf8"), sandbox);
    const send = (message, sender) => new Promise((resolve) => handler(message, sender, resolve));
    const pair = {
      type: "connect",
      port: Number(new URL(f.connection.base).port),
      token: f.connection.token,
    };
    const popup = { id: "fixture", url: popupUrl };
    assert.equal(
      (
        await send(pair, {
          id: "fixture",
          url: "https://music.youtube.com/",
          tab: { id: 7 },
          frameId: 0,
        })
      ).paired,
      false,
    );
    assert.equal((await send(pair, popup)).paired, true);
    assert.equal(
      (
        await send(
          { type: "tick", snapshot: observation() },
          { id: "fixture", url: "https://music.youtube.com/", tab: { id: 8 }, frameId: 0 },
        )
      ).paired,
      false,
    );
    const response = await send(
      { type: "tick", snapshot: observation() },
      { id: "fixture", url: "https://music.youtube.com/", tab: { id: 7 }, frameId: 0 },
    );
    assert.equal(response.paired, true);
    assert.doesNotMatch(JSON.stringify(response), new RegExp(f.connection.token));
    assert.equal(f.bridge.status().fresh, true);
    await send({ type: "disconnect" }, popup);
    const localPage = {
      id: "fixture",
      url: `${f.connection.base}/connect.html`,
      frameId: 0,
      tab: { id: 12 },
    };
    const guided = { ...pair, type: "pairing-connect", tabId: 7 };
    for (const sender of [
      { ...localPage, frameId: 1 },
      { ...localPage, url: `${f.connection.base}/other.html` },
      { ...localPage, id: "another-extension" },
      { ...localPage, url: "https://music.youtube.com/connect.html" },
    ])
      assert.equal((await send(guided, sender)).paired, false);
    assert.equal((await send({ ...guided, token: "0".repeat(64) }, localPage)).paired, undefined);
    assert.equal(f.bridge.status().paired, false);
    const listed = await send({ ...pair, type: "pairing-tabs" }, localPage);
    assert.equal(listed.tabs.length, 1);
    assert.equal(f.bridge.status().paired, false, "listing is not pairing");
    assert.match((await send({ ...guided, tabId: undefined }, localPage)).error, /Select/);
    assert.equal((await send(guided, localPage)).paired, true);
    assert.equal(session.owner.tabId, 7);
  });
}
for (const [family, engine] of [
  ["Chromium", chromium],
  ["Firefox", firefox],
]) {
  test(`${family} DOM adapter observes partial queues and verifies manual controls without page APIs`, async (t) => {
    const browser = await engine.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.route("https://music.youtube.com/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><ytmusic-player-bar><a class="title" href="/watch?v=aaaaaaaaaaa">Fixture song</a><span class="byline"><a href="/channel/UCfixture">Fixture artist</a> &#8226; 38m views &#8226; 100 likes</span><button class="next-button">Next</button></ytmusic-player-bar><ytmusic-player><video></video></ytmusic-player><ytmusic-player-queue-item><a href="/watch?v=bbbbbbbbbbb">Queued song</a></ytmusic-player-queue-item><ytmusic-player-queue-item><span class="song-title">Title-only song</span><span class="byline">Other artist &#8226; Album</span></ytmusic-player-queue-item><ytmusic-player-queue-item><span class="song-title">Title-only song</span></ytmusic-player-queue-item>`,
      }),
    );
    await page.goto("https://music.youtube.com/watch?v=aaaaaaaaaaa");
    await page.evaluate(() => {
      const video = document.querySelector("video");
      Object.defineProperties(video, {
        readyState: { value: 4 },
        paused: { get: () => window.fixturePaused },
        duration: { value: 180 },
      });
      window.fixturePaused = false;
      video.pause = () => {
        window.fixturePaused = true;
      };
      video.play = async () => {
        window.fixturePaused = false;
      };
      document.querySelector("button").onclick = () => {
        document.querySelector("a.title").href = "/watch?v=ccccccccccc";
      };
    });
    await page.addScriptTag({ path: path.join(extension, "site-adapter.js") });
    const result = await page.evaluate(async () => {
      const site = globalThis.RaveLinkYouTubeSite.create(document, location);
      const before = site.read();
      const changed = await site.execute({ action: "pause", expectedVideoId: "ddddddddddd" });
      const pause = await site.execute({ action: "pause", expectedVideoId: "aaaaaaaaaaa" });
      const volume = await site.execute({
        action: "volume",
        value: 37,
        expectedVideoId: "aaaaaaaaaaa",
      });
      const skip = await site.execute({ action: "skip", expectedVideoId: "aaaaaaaaaaa" });
      return { before, changed, pause, volume, skip, after: site.read() };
    });
    assert.equal(result.before.current.title, "Fixture song");
    assert.equal(result.before.current.artist, "Fixture artist");
    assert.equal(result.before.queue.length, 3);
    assert.equal(result.before.queue[1].artist, "Other artist");
    assert.equal(result.before.queue[1].videoId, null);
    assert.equal(result.before.queue[1].identityAvailable, false);
    assert.equal(result.before.queueComplete, false);
    assert.equal(result.changed.error, "player_changed");
    assert.equal(result.pause.ok, true);
    assert.equal(result.volume.ok, true);
    assert.equal(result.skip.ok, true);
    assert.equal(result.after.volume, 37);
    assert.equal(result.after.current.videoId, "ccccccccccc");
  });
}
