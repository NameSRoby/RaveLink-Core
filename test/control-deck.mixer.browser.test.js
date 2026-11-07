/** Full Core UI with synthetic Windows channels; never changes the PC mixer. */
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const { chromium } = require("playwright"),
  createCore = require("../src/app/core/create-core-server"),
  createAudio = require("../src/domains/control-deck/windows-audio.service");
test("mixer keeps Windows and request faders in one row, protects drags, docks in edit, and leaves widgets above fullscreen controls", async (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "rvl-mixer-ui-")),
    writes = [];
  const system = {
      key: "device:" + "a".repeat(64),
      name: "Demo speakers",
      kind: "output",
      volume: 45,
      muted: false,
      isDefault: true,
    },
    player = {
      key: "app:" + "b".repeat(64),
      name: "TIDALPlayer",
      kind: "app",
      volume: 30,
      muted: false,
      sessions: 1,
    },
    chat = {
      key: "app:" + "c".repeat(64),
      name: "Demo chat",
      kind: "app",
      volume: 70,
      muted: false,
      sessions: 1,
    },
    state = {
      available: true,
      output: system,
      input: null,
      devices: [system],
      apps: [player, chat],
    },
    volume = { control: 30, outputPercent: 30, floorPercent: 0, ceilingPercent: 100 };
  let concurrent = 0,
    maxConcurrent = 0;
  const audio = createAudio({
    available: true,
    request: async (operation, command) => {
      if (operation === "audio.set") {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 90));
        const row =
          command.target === "system"
            ? system
            : state.apps.find((app) => app.key === command.target);
        assert(row);
        if (command.action === "volume") row.volume = command.level;
        else row.muted = !row.muted;
        writes.push(command);
        concurrent--;
      }
      return structuredClone(state);
    },
  });
  const registry = {
    list: () => ({
      features: [
        { id: "song-request", name: "Song Request", version: "0.45.9", lifecycle: "active" },
      ],
    }),
    request: async (_id, cap, _method, payload) => ({
      ok: true,
      value:
        cap === "song.player.preferences.v1"
          ? { player: "tidal" }
          : cap === "song.queue.read.v1"
            ? { paused: false, queue: [], counts: { queued: 0 }, volume }
            : cap === "song.playback.read.v1"
              ? { control: { paused: false } }
              : cap === "song.tidal.experimental.v1"
                ? { ok: true, enabled: false }
                : cap === "song.queue.admin.v1"
                  ? ((volume.control = payload.value), { ok: true })
                  : { ok: true },
    }),
  };
  const core = createCore({
    runtimeDir,
    dryRun: true,
    desktopActions: {
      catalog: audio.catalog,
      execute: audio.execute,
      audioStatus: audio.read,
      audioSnapshot: audio.snapshot,
      audioApply: audio.apply,
      refresh: audio.read,
      shutdown: audio.shutdown,
      integrations: async () => ({}),
    },
    extend: () => ({ registry, shutdown: async () => {} }),
  });
  const initial = core.services.controlDeck.snapshot();
  initial.config.mode = "deck";
  initial.config.widgets = {
    enabled: true,
    fullscreen: true,
    columns: 3,
    items: [{ id: "clock", type: "clock" }],
  };
  initial.config.layout.radius = 30;
  core.services.controlDeck.save(initial.config, initial.revision);
  const server = await new Promise((resolve) => {
      const s = core.app.listen(0, "127.0.0.1", () => resolve(s));
    }),
    browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await core.services.lifecycle.stopAll();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, hasTouch: true }),
    errors = [];
  page.setDefaultTimeout(12000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator("#deckButtonMode").click();
  await page.getByRole("button", { name: "Audio mixer", exact: true }).click();
  const mixer = page.locator("#deckAudioMixer"),
    systemSlider = mixer.getByRole("slider", { name: "System audio volume", exact: true });
  await systemSlider.waitFor();
  const mixerBounds = await mixer.boundingBox(),
    hostBounds = await page.locator("#controlDeck").boundingBox();
  assert(
    mixerBounds.width >= hostBounds.width - 60,
    "inline mixer uses the deck width instead of the popup's width limit",
  );
  await page.waitForFunction(() =>
    document.querySelector('#deckAudioMixer [data-deck-button="mixer-song-volume"]'),
  );
  assert.equal(writes.length, 0);
  const order = await mixer
    .locator(".deckMixerChannels")
    .evaluate((row) =>
      [...row.children].map((card) =>
        card.querySelector('input[type="range"]')?.getAttribute("aria-label"),
      ),
    );
  assert.deepEqual(order, [
    "System audio volume",
    "TIDALPlayer volume",
    "Song Request",
    "Demo chat volume",
  ]);
  const tops = await mixer
    .locator(".deckMixerChannels > *")
    .evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().top)));
  assert.equal(new Set(tops).size, 1);
  await systemSlider.evaluate((input) => {
    input.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1 }));
    input.value = "80";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.evaluate(
    (state) => document.dispatchEvent(new CustomEvent("ravelink-deck-state", { detail: state })),
    { ...state, output: { ...system, volume: 10 } },
  );
  assert.equal(
    await mixer.locator('input[aria-label="System audio volume"]').inputValue(),
    "80",
    "stale snapshots cannot move the thumb during a drag",
  );
  await systemSlider.evaluate((input) => {
    for (let value = 81; value <= 95; value++) {
      input.value = String(value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));
  });
  await page.waitForFunction(
    () =>
      document.querySelector('#deckAudioMixer input[aria-label="System audio volume"]').value ===
      "95",
  );
  await new Promise((resolve) => {
    const poll = () => (system.volume === 95 ? resolve() : setTimeout(poll, 30));
    poll();
  });
  assert.equal(maxConcurrent, 1);
  assert(writes.length <= 3);
  const song = mixer.getByRole("slider", { name: "Song Request", exact: true });
  await song.fill("55");
  await page.waitForFunction(
    () =>
      document.querySelector('#deckAudioMixer input[aria-label="TIDALPlayer volume"]').value ===
      "55",
  );
  assert.equal(player.volume, 55);
  await page.screenshot({ path: path.resolve("runtime/mixer-acrylic-076-private.png") });
  await page.getByRole("button", { name: "Quick Access", exact: true }).click();
  await page.locator("#deckEdit").click();
  assert.equal(await page.locator("#deckSliderRack .deckVolumeSlider").count(), 1);
  assert.equal(await page.locator("#deckGrid .deckVolumeSlider").count(), 0);
  for (const orientation of ["vertical", "horizontal"])
    for (const side of ["start", "end"]) {
      const latest = core.services.controlDeck.snapshot();
      latest.config.layout.sliderOrientation = orientation;
      latest.config.layout.sliderDock = side;
      core.services.controlDeck.save(latest.config, latest.revision);
      await page.waitForFunction(
        ({ orientation, side }) => {
          const host = document.querySelector("#controlDeck");
          return host.dataset.sliderOrientation === orientation && host.dataset.sliderDock === side;
        },
        { orientation, side },
      );
      const dock = await page.locator("#deckSliderRack").boundingBox(),
        grid = await page.locator("#deckGrid").boundingBox();
      assert(dock && grid);
      if (orientation === "vertical")
        assert(
          side === "start" ? dock.x + dock.width <= grid.x + 1 : grid.x + grid.width <= dock.x + 1,
          JSON.stringify({ orientation, side, dock, grid }),
        );
      else
        assert(
          side === "start"
            ? dock.y + dock.height <= grid.y + 1
            : grid.y + grid.height <= dock.y + 1,
        );
    }
  const latest = core.services.controlDeck.snapshot();
  latest.config.layout.sliderOrientation = "vertical";
  latest.config.layout.sliderDock = "end";
  latest.config.layout.fullscreenMode = "pages";
  latest.config.layout.fullscreenSwipe = true;
  core.services.controlDeck.save(latest.config, latest.revision);
  await page.waitForFunction(
    () => document.querySelector("#controlDeck").dataset.sliderOrientation === "vertical",
  );
  const widget = await page.locator(".deckWidgetRegion").boundingBox(),
    workspace = await page.locator(".deckWorkspace").boundingBox();
  assert(widget.y + widget.height <= workspace.y + 1);
  await page.locator("#deckEdit").click();
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.locator("#deckFocus").click();
  const awake = await page.locator("#deckKeepAwake").boundingBox(),
    widgets = await page.locator(".deckWidgetRegion").boundingBox();
  assert(awake.y + awake.height <= widgets.y + 1);
  assert.equal(await page.getByRole("switch", { name: "Keep screen awake" }).isChecked(), true);
  await page.screenshot({ path: path.resolve("runtime/deck-tablet-awake-076-private.png") });
  for (let count = 0; count < 10 && !(await mixer.isVisible()); count++)
    await page.getByRole("button", { name: "Next screen", exact: true }).click();
  await mixer.waitFor({ state: "visible" });
  assert(
    await mixer.evaluate((element) => element.scrollHeight <= element.clientHeight + 1),
    "fitting channels do not create an inner vertical scroller",
  );
  const client = await page.context().newCDPSession(page),
    bounds = await systemSlider.boundingBox(),
    beforeWrites = writes.length;
  const touch = async (type, x, y) =>
    client.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: type === "touchEnd" ? [] : [{ x, y }],
    });
  const x = bounds.x + bounds.width / 2,
    y = bounds.y + bounds.height / 2;
  await touch("touchStart", x, y);
  await touch("touchMove", x + 75, y);
  await touch("touchMove", x + 150, y);
  await touch("touchEnd");
  await page.waitForFunction(() =>
    document.querySelector(".deckScreenNav span").textContent.startsWith("Quick Access"),
  );
  assert.equal(writes.length, beforeWrites, "swiping sideways across a fader never writes volume");
  assert.equal(system.volume, 95);
  for (let count = 0; count < 10 && !(await mixer.isVisible()); count++)
    await page.getByRole("button", { name: "Next screen", exact: true }).click();
  await mixer.waitFor({ state: "visible" });
  const fader = await systemSlider.boundingBox(),
    fx = fader.x + fader.width / 2,
    fy = fader.y + fader.height / 2;
  await touch("touchStart", fx, fy);
  await touch("touchMove", fx, fy + 25);
  await touch("touchMove", fx, fy + 45);
  await touch("touchEnd");
  await page.waitForFunction(
    () =>
      Number(
        document.querySelector('#deckAudioMixer input[aria-label="System audio volume"]').value,
      ) < 95,
  );
  for (let attempt = 0; attempt < 50 && system.volume === 95; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert(system.volume < 95, "a deliberate vertical touch drag still adjusts actual volume");
  assert.equal(maxConcurrent, 1);
  await page.waitForTimeout(250);
  const songBounds = await song.boundingBox(),
    songX = songBounds.x + songBounds.width / 2,
    songY = songBounds.y + songBounds.height / 2;
  await touch("touchStart", songX, songY);
  for (let delta = 8; delta <= 40; delta += 4) {
    await touch("touchMove", songX, songY + delta);
    assert(
      await song.evaluate((input) => !input.closest(".deckButton").disabled),
      "a volume write in flight must not disable the parent of the active fader",
    );
    await page.waitForTimeout(16);
  }
  await touch("touchEnd");
  const expectedSongLevel = Number(await song.inputValue());
  for (let attempt = 0; attempt < 50 && player.volume !== expectedSongLevel; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    player.volume,
    expectedSongLevel,
    "continuous request fader drag delivers its final value",
  );
  for (let index = 4; index < 10; index++)
    state.apps.push({
      key: "app:" + index.toString(16).repeat(64),
      name: "Demo app " + index,
      kind: "app",
      volume: 60,
      muted: false,
      sessions: 1,
    });
  await page.evaluate(
    (state) => document.dispatchEvent(new CustomEvent("ravelink-deck-state", { detail: state })),
    await audio.read(true),
  );
  await page.waitForFunction(() =>
    /Audio mixer · 1 \/ [2-9]/.test(document.querySelector(".deckScreenNav span").textContent),
  );
  const countBeforePaging = writes.length;
  const swipeFader = async (direction) => {
    const ranges = mixer.locator("input[type=range]:visible"),
      bounds = await (direction < 0 ? ranges.last() : ranges.first()).boundingBox(),
      sx = bounds.x + bounds.width / 2,
      sy = bounds.y + bounds.height / 2;
    await touch("touchStart", sx, sy);
    await touch("touchMove", sx + direction * 75, sy);
    await touch("touchMove", sx + direction * 150, sy);
    await touch("touchEnd");
  };
  await swipeFader(-1);
  await page.waitForFunction(() =>
    /Audio mixer · 2 \/ /.test(document.querySelector(".deckScreenNav span").textContent),
  );
  await page.waitForTimeout(1850);
  system.volume = 64;
  await page.evaluate(
    (state) => document.dispatchEvent(new CustomEvent("ravelink-deck-state", { detail: state })),
    await audio.read(true),
  );
  assert.equal(
    await mixer.locator('input[aria-label="System audio volume"]').inputValue(),
    "64",
    "a fader released on the pager remains synchronized after capture transfers",
  );
  await page.evaluate(
    (state) => document.dispatchEvent(new CustomEvent("ravelink-deck-state", { detail: state })),
    await audio.read(true),
  );
  assert.match(await page.locator(".deckScreenNav span").textContent(), /Audio mixer · 2 \/ /);
  await swipeFader(1);
  await page.waitForFunction(() =>
    /Audio mixer · 1 \/ /.test(document.querySelector(".deckScreenNav span").textContent),
  );
  await swipeFader(1);
  await page.waitForFunction(() =>
    document.querySelector(".deckScreenNav span").textContent.startsWith("Quick Access"),
  );
  assert.equal(
    writes.length,
    countBeforePaging,
    "overflow mixer pages swipe without scrolling the bank or changing audio: " +
      JSON.stringify(writes.slice(countBeforePaging)),
  );
  assert.deepEqual(errors, []);
});
