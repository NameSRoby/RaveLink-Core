const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const { chromium } = require("playwright");
const createCore = require("../src/app/core/create-core-server");
const extension = require("../src/app/optional/create-feature-platform-extension");

test("explicitly enabled TIDAL bridge reconnects after Core restart without opening the Player page", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-tidal-restart-"));
  fs.cpSync(
    path.join(__dirname, "../features/song-request"),
    path.join(root, "installed/song-request"),
    { recursive: true },
  );
  let current;
  const start = async () => {
    current = createCore({
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
    await current.extension.startup;
  };
  const stop = async () => {
    if (!current) return;
    await current.extension.shutdown();
    await current.services.lifecycle.stopAll();
    current = null;
  };
  t.after(async () => {
    await stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const call = (method) =>
    current.extension.registry.request(
      "song-request",
      "song.tidal.experimental.v1",
      method,
      method === "status" ? null : {},
    );
  await start();
  assert.equal((await call("status")).value.enabled, false);
  assert.equal((await call("enable")).value.enabled, true);
  await stop();
  await start();
  const after = await call("status");
  assert.equal(after.ok, true);
  assert.equal(after.value.enabled, true);
  assert.equal(
    after.value.connected,
    false,
    "persisting intent cannot invent a connected companion",
  );
});
test("one SoundCloud playback surface and inline output range work across selected providers", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-player-volume-")),
    native = [];
  let nativeGate, releaseNative;
  fs.cpSync(
    path.join(__dirname, "../features/song-request"),
    path.join(root, "installed/song-request"),
    { recursive: true },
  );
  const status = {
    ok: true,
    enabled: true,
    connected: true,
    ready: true,
    volumeAvailable: true,
    queue: [],
    handoffs: [],
  };
  const created = createCore({
    rootDir: path.join(__dirname, ".."),
    runtimeDir: path.join(root, "runtime"),
    dryRun: true,
    capabilities: { features: true },
    extend: extension({
      featuresRoot: path.join(root, "installed"),
      runtimeRoot: path.join(root, "features-runtime"),
      allowUnsafeRuntime: true,
      providers: {
        "tidal.desktop.experimental.v1/status": () => status,
        "tidal.desktop.experimental.v1/manage-companion": () => ({
          ok: true,
          available: true,
          installed: true,
          version: "0.1.8",
        }),
        "tidal.desktop.experimental.v1/volume": async (input) => {
          native.push(input.percent);
          await nativeGate;
          return { ok: true, percent: input.percent };
        },
      },
    }),
  });
  await created.extension.startup;
  const server = await new Promise((resolve) => {
    const listener = created.app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const browser = await chromium.launch({ headless: true }),
    context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
  t.after(async () => {
    releaseNative?.();
    await browser.close();
    await created.extension.shutdown();
    await created.services.lifecycle.stopAll();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  await context.route("https://www.youtube.com/iframe_api", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "" }),
  );
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/features-ui/song-request/player`);
  const surface = page.locator("#surface").contentFrame();
  await surface
    .locator('[data-choice-for="songPlayerProvider"] button:not([disabled])')
    .first()
    .waitFor();
  await surface.locator("body").evaluate(() => {
    window.volumeCalls = [];
    player = {
      setVolume: (value) => window.volumeCalls.push(value),
      pauseVideo() {},
    };
  });
  await surface.locator("#volumeCeiling").fill("100");
  await surface.locator("#volumeCeiling").press("Enter");
  await surface.locator("#volumeNotice").filter({ hasText: "Output range saved." }).waitFor();
  await surface.locator("#volume").fill("50");
  await surface.locator("#volume").dispatchEvent("change");
  await surface.locator("#volumeOut").filter({ hasText: "OUTPUT 50%" }).waitFor();
  assert.equal(await surface.locator("#playerVolume #volumeFloor").count(), 1);
  const state = await created.extension.registry.request(
    "song-request",
    "song.queue.read.v1",
    "status",
    { limit: 1 },
  );
  assert.equal(state.value.volume.ceilingPercent, 100);
  await context.route("https://w.soundcloud.com/player/?**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<p>SoundCloud fixture</p>",
    }),
  );
  await surface.locator("body").evaluate(() => {
    window.scVolumes = [];
    window.SC = {
      Widget: Object.assign(
        () => {
          const events = {};
          window.scEvents = events;
          return {
            bind(name, fn) {
              events[name] = fn;
              if (name === "ready") setTimeout(fn, 0);
            },
            unbind() {},
            pause() {},
            play() {
              events.play?.();
            },
            setVolume(value) {
              window.scVolumes.push(value);
            },
          };
        },
        {
          Events: {
            READY: "ready",
            PLAY: "play",
            PLAY_PROGRESS: "progress",
            PAUSE: "pause",
            FINISH: "finish",
            ERROR: "error",
          },
        },
      ),
    };
  });
  await page.waitForTimeout(1000); // Separate deliberate user interactions from the supervisor's IPC burst window.
  await surface
    .locator('[data-choice-for="songPlayerProvider"] [data-choice-value="soundcloud"]')
    .click();
  await surface
    .locator(
      '[data-choice-for="songPlayerProvider"] [data-choice-value="soundcloud"]:not([disabled])',
    )
    .waitFor();
  await surface.locator("#soundcloudPlayer:not([hidden])").waitFor();
  await created.extension.registry.request("song-request", "song.soundcloud.player.v1", "submit", {
    requestId: "volume-soundcloud",
    sound: {
      id: "123456789",
      title: "Volume fixture",
      duration: 180000,
      policy: "ALLOW",
      user: { username: "Artist" },
    },
  });
  await surface.locator("#soundcloudStart").click();
  await surface.locator("#soundcloudState").filter({ hasText: "Playing Volume fixture" }).waitFor();
  assert.equal(await surface.locator("#soundcloudFrame iframe").count(), 1);
  assert.equal(await surface.locator(".now").isHidden(), true);
  assert.equal(await surface.locator("#tidalNowControls").isVisible(), false);
  assert.equal(await surface.locator("#playerVolume").isVisible(), true);
  await surface.locator("#volumeCeiling").fill("80");
  await surface.locator("#volumeCeiling").press("Enter");
  await surface.locator("#volumeOut").filter({ hasText: "OUTPUT 40%" }).waitFor();
  await surface.locator("#volumeFloor").fill("90");
  await surface.locator("#volumeFloor").press("Enter");
  await surface
    .locator("#volumeNotice")
    .filter({ hasText: "Minimum output cannot exceed maximum output." })
    .waitFor();
  await surface.locator("#volumeFloor").fill("0");
  await surface.locator("#volumeFloor").press("Enter");
  await surface.locator("#volumeNotice").filter({ hasText: "Output range saved." }).waitFor();
  assert.equal(await surface.locator("body").evaluate(() => window.scVolumes.at(-1)), 40);
  await surface.locator("body").evaluate(() => window.scEvents.finish());
  await surface.locator("#soundcloudState").filter({ hasText: "Waiting for requests" }).waitFor();
  assert.equal(await surface.locator("#soundcloudFrame iframe").count(), 0);
  await page.waitForTimeout(1000);
  await surface
    .locator('[data-choice-for="songPlayerProvider"] [data-choice-value="tidal"]')
    .click();
  await surface
    .locator('[data-choice-for="songPlayerProvider"] [data-choice-value="tidal"]:not([disabled])')
    .waitFor();
  await surface.locator("#volume:not([disabled])").waitFor();
  assert.equal(await surface.locator(".now").isVisible(), true);
  nativeGate = new Promise((resolve) => {
    releaseNative = resolve;
  });
  const beforeWrites = native.length;
  await surface.locator("#volume").fill("30");
  await surface.locator("#volume").dispatchEvent("change");
  const deadline = Date.now() + 5000;
  while (native.length === beforeWrites && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert(native.length > beforeWrites, "native write started");
  await surface.locator("#volume").fill("45");
  await surface.locator("#volume").dispatchEvent("change");
  await surface.locator("body").evaluate(async () => {
    await refreshState();
  });
  assert.equal(
    await surface.locator("#volume").inputValue(),
    "45",
    "polling must not reset an in-flight adjustment",
  );
  releaseNative();
  nativeGate = null;
  await surface.locator("#volumeNotice").filter({ hasText: "Volume saved." }).waitFor();
  assert.equal(
    native.at(-1),
    36,
    "the final value follows the first write without competing requests",
  );
  await surface.locator("#volume").fill("25");
  await surface.locator("#volume").dispatchEvent("change");
  await surface.locator("#volumeNotice").filter({ hasText: "Volume saved." }).waitFor();
  assert.equal(native.at(-1), 20);
  status.volumeAvailable = false;
  await page.waitForTimeout(1000); // Separate deliberate user interactions from the supervisor's IPC burst window.
  await surface
    .locator('[data-choice-for="songPlayerProvider"] [data-choice-value="soundcloud"]')
    .click();
  await surface
    .locator(
      '[data-choice-for="songPlayerProvider"] [data-choice-value="soundcloud"]:not([disabled])',
    )
    .waitFor();
  await page.waitForTimeout(1000);
  await surface
    .locator('[data-choice-for="songPlayerProvider"] [data-choice-value="tidal"]')
    .click();
  await surface
    .locator('[data-choice-for="songPlayerProvider"] [data-choice-value="tidal"]:not([disabled])')
    .waitFor();
  assert.equal(await surface.locator("#volume").isDisabled(), true);
  assert.equal(await surface.locator("#volumeCeiling").isVisible(), true);
  await page.waitForTimeout(1000);
  await surface
    .locator('[data-choice-for="songPlayerProvider"] [data-choice-value="youtube"]')
    .click();
  await surface
    .locator('[data-choice-for="songPlayerProvider"] [data-choice-value="youtube"]:not([disabled])')
    .waitFor();
  await surface.locator("#volume:not([disabled])").waitFor();
  await surface.locator("#volumeFloor").fill("5");
  await surface.locator("#volumeFloor").press("Enter");
  await surface
    .locator("#volumeNotice")
    .filter({ hasText: "Output range saved." })
    .waitFor({ timeout: 3000 })
    .catch(async () => {
      throw new Error(
        "Custom range: " +
          JSON.stringify(
            await surface.locator("body").evaluate(() => ({
              notice: document.getElementById("volumeNotice").textContent,
              floor: document.getElementById("volumeFloor").value,
              ceil: document.getElementById("volumeCeiling").value,
              provider: document.getElementById("songPlayerProvider").value,
            })),
          ) +
          "; errors:" +
          JSON.stringify(errors),
      );
    });
  await surface.locator("#volumeCeiling").fill("65");
  await surface.locator("#volumeCeiling").press("Enter");
  await surface.locator("#volumeOut").filter({ hasText: "OUTPUT 20%" }).waitFor();
  await surface.locator("#volume").fill("50");
  await surface.locator("#volume").dispatchEvent("change");
  await surface.locator("#volumeOut").filter({ hasText: "OUTPUT 35%" }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await surface
      .locator("body")
      .evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true,
  );
  assert.deepEqual(errors, []);
});
