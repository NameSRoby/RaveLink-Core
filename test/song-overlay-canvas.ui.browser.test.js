const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { chromium } = require("playwright");
const createCoreServer = require("../src/app/core/create-core-server");
const extension = require("../src/app/optional/create-feature-platform-extension");
test("overlay canvas dragging, snapping, resizing and persistence work through the supervised bridge", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-overlay-profiles-"));
  fs.cpSync(
    path.join(__dirname, "../features/song-request"),
    path.join(root, "installed/song-request"),
    { recursive: true },
  );
  const created = createCoreServer({
    rootDir: path.join(__dirname, ".."),
    runtimeDir: path.join(root, "runtime"),
    dryRun: true,
    capabilities: { features: true },
    extend: extension({
      featuresRoot: path.join(root, "installed"),
      runtimeRoot: path.join(root, "runtime/features"),
      allowUnsafeRuntime: true,
      providers: {
        "youtube.catalog.host.v1/resolve": async () => ({
          ok: true,
          candidate: {
            provider: "youtube",
            providerItemId: "M7lc1UVf-VE",
            title: "A very long song title that keeps scrolling across every layout in this test",
            artists: ["Artist"],
            durationMs: 200000,
          },
        }),
      },
    }),
  });
  await created.extension.startup;
  const server = await new Promise((r) => {
    const s = created.app.listen(0, "127.0.0.1", () => r(s));
  });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await created.extension.shutdown();
    await new Promise((r) => server.close(r));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = "http://127.0.0.1:" + server.address().port;
  async function call(method, payload = {}, capability = "song.overlay.admin.v1") {
    const r = await fetch(base + "/api/features/song-request/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capability, method, payload }),
    });
    const body = await r.json();
    assert.equal(body.ok, true, JSON.stringify(body));
    return body.value;
  }
  const page = await browser.newPage({
    viewport: { width: 1400, height: 1000 },
  });
  await page.goto(base + "/features-ui/song-request/overlay-editor");
  const editor = page.locator("#surface").contentFrame();
  await editor.locator("#preset option").nth(7).waitFor({ state: "attached" });
  assert.equal(
    await editor.locator(".task-navigation button[aria-pressed=true]").textContent(),
    "Style",
  );
  assert.equal(await editor.locator(".profile-bar").isVisible(), false);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // A segment label makes the preset editable directly, without a mode switch.
  await editor.locator(".canvas-segment-label").first().click();
  const initial = await editor.locator("#preview").evaluate(() => structuredClone(config));
  assert.equal(initial.layoutMode, "canvas");
  assert.equal(initial.autoHeight, false);
  assert.ok(initial.segments[0].frame.width > 100);
  await editor.locator('[data-constraint="lockRatio"]').check();
  await editor
    .locator('[data-geometry="width"]')
    .fill(String(Math.round(initial.segments[0].frame.width * 0.75)));
  await editor.locator('[data-geometry="width"]').dispatchEvent("change");
  let scaled = await editor.locator("#preview").evaluate(() => structuredClone(config.segments[0]));
  const factor = scaled.frame.width / initial.segments[0].frame.width;
  assert.ok(Math.abs(scaled.frame.height - initial.segments[0].frame.height * factor) <= 1);
  for (const original of initial.segments[0].blocks) {
    const block = scaled.blocks.find((b) => b.id === original.id);
    assert.ok(Math.abs(block.frame.width - original.frame.width * factor) <= 1);
    assert.ok(block.contentScale < 1, "segment resize scales typography and artwork too");
  }
  assert.match(await editor.locator(".canvas-measurement").textContent(), /px.*X.*Y/);
  const segmentCorner = await editor.locator(".canvas-handle.se").boundingBox();
  await page.mouse.move(segmentCorner.x + 4, segmentCorner.y + 4);
  await page.mouse.down();
  await page.mouse.move(segmentCorner.x + 34, segmentCorner.y + 24, { steps: 4 });
  const dragged = await editor
    .locator("#preview")
    .evaluate(() => structuredClone(config.segments[0]));
  assert.ok(dragged.frame.width > scaled.frame.width, "segment corner scales the full group");
  assert.ok(dragged.blocks[0].contentScale > scaled.blocks[0].contentScale);
  await page.mouse.move(segmentCorner.x + 4, segmentCorner.y + 4, { steps: 4 });
  await page.mouse.up();
  const restored = await editor
    .locator("#preview")
    .evaluate(() => structuredClone(config.segments[0]));
  assert.deepEqual(
    restored.blocks,
    scaled.blocks,
    "out-and-back resizing does not accumulate drift",
  );
  await editor.locator('[data-constraint="lockSize"]').check();
  assert.equal(await editor.locator(".canvas-handle").count(), 0);
  assert.equal(await editor.locator('[data-geometry="width"]').isDisabled(), true);
  await editor.locator('[data-constraint="lockSize"]').uncheck();
  await editor.locator('[data-constraint="lockRatio"]').uncheck();
  await editor.locator('[data-constraint="scaleContents"]').uncheck();
  const contentBefore = JSON.stringify(scaled.blocks);
  await editor.locator('[data-geometry="width"]').fill(String(scaled.frame.width + 20));
  await editor.locator('[data-geometry="width"]').dispatchEvent("change");
  scaled = await editor.locator("#preview").evaluate(() => structuredClone(config.segments[0]));
  assert.equal(
    JSON.stringify(scaled.blocks),
    contentBefore,
    "container-only resize preserves contents",
  );
  await editor.locator('[data-constraint="scaleContents"]').check();
  await editor.locator('#preview [data-block-id="song-title"]').click();
  await editor.getByRole("button", { name: "Center horizontally", exact: true }).click();
  let c = await editor.locator("#preview").evaluate(() => structuredClone(config));
  let row = c.segments[0],
    title = row.blocks.find((b) => b.kind === "title");
  assert.equal(title.frame.x, Math.max(0, Math.round((row.frame.width - title.frame.width) / 2)));
  const before = { ...title.frame };
  const titleNode = editor.locator('#preview [data-block-id="song-title"]');
  const box = await titleNode.boundingBox();
  await page.mouse.move(box.x + 8, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + 34, box.y + 20, { steps: 4 });
  await page.mouse.up();
  c = await editor.locator("#preview").evaluate(() => structuredClone(config));
  title = c.segments[0].blocks.find((b) => b.kind === "title");
  assert.ok(title.frame.x !== before.x || title.frame.y !== before.y, "drag moves information");
  const handle = await editor.locator(".canvas-handle.se").boundingBox();
  const oldWidth = title.frame.width;
  await page.mouse.move(handle.x + 4, handle.y + 4);
  await page.mouse.down();
  await page.mouse.move(handle.x + 24, handle.y + 14, { steps: 3 });
  await page.mouse.up();
  c = await editor.locator("#preview").evaluate(() => structuredClone(config));
  assert.ok(
    c.segments[0].blocks.find((b) => b.kind === "title").frame.width > oldWidth,
    "corner resizes information",
  );
  // Dragging near the shape center snaps exactly and displays a live guide.
  await editor.locator("#preview").evaluate(() => {
    const row = config.segments[0],
      b = row.blocks.find((b) => b.kind === "title");
    row.frame = { x: 10, y: 10, width: 280, height: 110 };
    b.frame = { x: 10, y: 20, width: 100, height: 25 };
    selectedShapeId = row.id;
    selectedPreviewPiece = b.id;
    changed(true);
  });
  const snapBox = await titleNode.boundingBox();
  await page.mouse.move(snapBox.x + 20, snapBox.y + 12);
  await page.mouse.down();
  await page.mouse.move(snapBox.x + 97, snapBox.y + 12, { steps: 3 });
  assert.ok(
    (await editor.locator(".canvas-guide.x").count()) > 0,
    "alignment guide is visible during drag",
  );
  await page.mouse.up();
  c = await editor.locator("#preview").evaluate(() => structuredClone(config));
  assert.equal(
    c.segments[0].blocks.find((b) => b.kind === "title").frame.x,
    90,
    "drag snaps center to shape center",
  );
  const snapY = c.segments[0].blocks.find((b) => b.kind === "title").frame.y;
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("ArrowRight");
  c = await editor.locator("#preview").evaluate(() => structuredClone(config));
  assert.equal(
    c.segments[0].blocks.find((b) => b.kind === "title").frame.x,
    92,
    "repeated arrow keys retain focus and nudge 1px",
  );
  assert.equal(
    c.segments[0].blocks.find((b) => b.kind === "title").frame.y,
    snapY + 10,
    "Shift nudges 10px",
  );
  await editor.locator("#new-shape").selectOption("ellipse");
  await editor.locator("#add-shape").click();
  assert.equal(await editor.locator("#preview .shape-ellipse").count(), 1);
  await editor.locator("#new-information").selectOption("artists");
  await editor.locator("#canvas-add-information").click();
  await editor.locator('[data-geometry="x"]').fill("15");
  await editor.locator('[data-geometry="x"]').dispatchEvent("change");
  await editor.locator("#canvas-height").fill("100");
  await editor.locator("#canvas-height").dispatchEvent("change");
  await editor.locator("#save").click();
  await editor.locator("#status").filter({ hasText: "Overlay saved" }).waitFor();
  let saved = await call("status", null, "song.overlay.read.v1");
  assert.equal(saved.config.height, 100);
  assert.equal(saved.config.segments.at(-1).shape, "ellipse");
  assert.equal(saved.config.segments.at(-1).blocks[0].frame.x, 15);
  assert.equal(saved.config.segments[0].scaleContents, true);
  assert.ok(saved.config.segments[0].blocks[0].contentScale < 1);
  await page.reload();
  await editor.locator("#edit-canvas").filter({ hasText: "Canvas editing active" }).waitFor();
  assert.equal(await editor.locator("#canvas-height").inputValue(), "100");
  assert.equal(await editor.locator("#preview .shape-ellipse").count(), 1);
  assert.deepEqual(errors, []);
});

test("long titles scroll with reduced motion and remeasure after resizing; artwork decodes", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
    reducedMotion: "reduce",
  });
  await page.setContent('<div id="stage"></div>');
  await page.addStyleTag({
    content: fs.readFileSync(
      path.join(__dirname, "../features/song-request/ui/overlay-renderer.css"),
      "utf8",
    ),
  });
  await page.addScriptTag({
    content: fs.readFileSync(
      path.join(__dirname, "../features/song-request/ui/overlay-renderer.js"),
      "utf8",
    ),
  });
  const config = require("../features/song-request/dist/overlay-presets").get("album-card");
  await page.evaluate((c) => {
    const art = document.createElement("canvas");
    art.width = art.height = 32;
    art.getContext("2d").fillRect(0, 0, 32, 32);
    SongOverlayRenderer.render(
      document.getElementById("stage"),
      c,
      {
        status: "paused",
        candidate: {
          title:
            "A very long song title that must keep moving across this frosted album card and never stop early",
          artists: ["An artist name that is much longer than the available card width"],
          artworkUrl: art.toDataURL("image/jpeg"),
        },
      },
      [],
    );
  }, config);
  await page.waitForFunction(() =>
    document.querySelector(".titleViewport").classList.contains("scrolling"),
  );
  const before = await page
    .locator(".marqueeTrack")
    .evaluate((el) => getComputedStyle(el).transform);
  await page.waitForFunction(
    (previous) => getComputedStyle(document.querySelector(".marqueeTrack")).transform !== previous,
    before,
  );
  assert.equal(
    await page.locator(".marqueeTrack").evaluate((el) => getComputedStyle(el).animationName),
    "song-ticker",
  );
  assert.equal(
    await page.locator(".artwork img").evaluate((img) => img.complete && img.naturalWidth > 0),
    true,
  );
  const measurement = await page.locator(".titleViewport").getAttribute("data-marquee-ready");
  await page.locator(".titleViewport").evaluate((el) => (el.style.width = "80px"));
  await page.waitForFunction(
    (previous) => document.querySelector(".titleViewport").dataset.marqueeReady !== previous,
    measurement,
  );
  assert.equal(await page.locator(".marqueeTrack h1").count(), 2);
  assert.equal(
    await page.locator(".artistTrack [aria-hidden]").count(),
    1,
    "long artists remain fully readable through scrolling too",
  );
  assert.equal(
    await page.locator(".artistTrack").evaluate((el) => getComputedStyle(el).animationName),
    "song-ticker",
  );
  const geometry = await page.evaluate((saved) => {
    const c = structuredClone(saved);
    c.layoutMode = "canvas";
    c.autoHeight = false;
    c.height = 100;
    c.segments = [
      {
        ...c.segments[0],
        frame: { x: 0, y: 0, width: 200, height: 80 },
        blocks: [
          {
            id: "scaled-cover",
            kind: "artwork",
            contentScale: 0.5,
            frame: { x: 0, y: 0, width: 44, height: 44 },
          },
          {
            id: "scaled-title",
            kind: "title",
            contentScale: 0.5,
            frame: { x: 50, y: 0, width: 140, height: 16 },
          },
          {
            id: "scaled-progress",
            kind: "progress",
            contentScale: 0.5,
            frame: { x: 50, y: 20, width: 140, height: 4 },
          },
        ],
      },
    ];
    SongOverlayRenderer.render(document.getElementById("stage"), c, {
      candidate: { title: "Track" },
    });
    return [...document.querySelectorAll(".block")].map((el) => ({
      width: el.getBoundingClientRect().width,
      height: el.getBoundingClientRect().height,
      scale: getComputedStyle(el).transform,
    }));
  }, config);
  assert.deepEqual(
    geometry.map(({ width, height }) => [width, height]),
    [
      [44, 44],
      [140, 16],
      [140, 4],
    ],
  );
  assert.ok(
    geometry.every((g) => g.scale === "matrix(0.5, 0, 0, 0.5, 0, 0)"),
    "OBS renderer scales artwork, text, and progress together",
  );
  await page.clock.install();
  const countdown = require("../features/song-request/dist/overlay-presets").get(
    "compact-countdown",
  );
  await page.evaluate((c) => {
    SongOverlayRenderer.render(document.getElementById("stage"), c, {
      status: "playing",
      positionMs: 84000,
      durationMs: 200000,
      observedAt: Date.now(),
      candidate: { title: "Track", artists: ["Artist"] },
    });
  }, countdown);
  assert.equal(await page.locator(".playbackRemaining").textContent(), "-1:56");
  const positions = await page.locator("#stage").evaluate((stage) => {
    const bar = stage.querySelector(".progress").getBoundingClientRect();
    const time = stage.querySelector(".playbackRemaining").getBoundingClientRect();
    return {
      gap: time.left - bar.right,
      centerDifference: Math.abs(time.top + time.height / 2 - bar.top - bar.height / 2),
    };
  });
  assert.ok(
    positions.gap > 0 && positions.gap < 12,
    "countdown sits immediately to the right of progress",
  );
  assert.ok(positions.centerDifference < 4, "countdown and bar share the same row");
  assert.equal((await page.locator("#stage").boundingBox()).height, 72);
  await page.clock.fastForward(1000);
  await page.locator("#stage").evaluate((stage) => SongOverlayRenderer.update(stage));
  assert.equal(await page.locator(".playbackRemaining").textContent(), "-1:55");
});
