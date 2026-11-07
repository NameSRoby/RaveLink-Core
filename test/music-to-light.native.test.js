/** Exercise native lighting HTTP/lifecycle with synthetic capture and native
 * fixture states. No user application, audio endpoint or physical bulb is used.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const express = require("express");
const createHost = require("../src/domains/music-to-light/music-to-light.service");
const registerRoutes = require("../src/app/core/register-music-to-light.routes");
const createBroker = require("../src/domains/fixtures/fixture-output-ownership.service");
const createSession = require("../integrations/music-to-light/session.cjs");
const flush = () => new Promise((resolve) => setImmediate(resolve));
async function waitFor(check) {
  const deadline = Date.now() + 4000;
  while (!(await check())) {
    if (Date.now() > deadline) assert.fail("lifecycle drain timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function environment(t, sourceRows, readPlayback, entertainment = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-music-wiring-"));
  let at = 0,
    captures = 0,
    stops = 0,
    probe,
    finish,
    renderer,
    frame = 0;
  const state = { on: false, bri: 90, ct: 350 },
    intervals = new Set();
  let native = { ...state };
  const broker = createBroker({
    now: () => at,
    isEligible: (id) => id === "music-bulb",
    readState: async () => ({ ok: true, state: { ...native } }),
    writeState: async (id, value) => {
      native = { ...value };
      return { sent: 1, failed: 0 };
    },
    restoreState: async (id, value) => {
      native = { ...value };
      return { sent: 1, failed: 0 };
    },
  });
  const host = createHost({
    readPlayback,
    core: {
      fixtureOutput: { ownership: broker },
      ...(entertainment
        ? {
            hueBridge: {
              prepareEntertainment:
                typeof entertainment === "function"
                  ? entertainment
                  : async () => ({ ok: true, activeIds: ["music-bulb"] }),
              stopEntertainment: async () => {},
            },
          }
        : {}),
      fixtureRegistry: {
        getFixtures: () => [
          {
            id: "music-bulb",
            name: "Music light",
            brand: "hue",
            enabled: true,
            ip: "192.0.2.1",
            username: "private-credential",
          },
        ],
      },
    },
    controllerOptions: {
      now: () => at,
      probeApi: {
        available: () => true,
        listSources: async () =>
          sourceRows || [
            {
              id: "process:10:20",
              label: "Test player",
              kind: "application",
              scope: "process_tree",
              executablePath: "private",
            },
          ],
        capture(id) {
          assert.equal(id, "process:10:20");
          captures++;
          probe = {
            events: new EventEmitter(),
            done: new Promise((resolve) => {
              finish = resolve;
            }),
            snapshot: () => ({ generation: "a".repeat(32) }),
            stop() {
              stops++;
              finish({});
            },
          };
          return probe;
        },
      },
      sessionFactory(options) {
        renderer = createSession({
          ...options,
          setTimeout: (fn) => {
            intervals.add(fn);
            return fn;
          },
          clearTimeout: (fn) => intervals.delete(fn),
        });
        return renderer;
      },
    },
  });
  const app = express();
  app.use(express.json());
  app.use(express.static(path.resolve(__dirname, "../public/core")));
  registerRoutes(app, { host });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await host.shutdown();
    await broker.shutdown();
    await new Promise((resolve) => server.close(resolve));
    assert.equal(intervals.size, 0);
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    host,
    base,
    intervals,
    advanceClock(ms) {
      at += ms;
    },
    get captures() {
      return captures;
    },
    get stops() {
      return stops;
    },
    get native() {
      return native;
    },
    baseline: state,
    setSourceRows: (rows) => {
      sourceRows = rows;
    },
    async http(route, method = "GET", body, origin) {
      return fetch(base + route, {
        method,
        headers: {
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(origin ? { Origin: origin } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    },
    call: (capability, method, payload = null) => host.call({ capability, method, payload }),
    async select(live = false) {
      await host.permissions({ capture: true, output: live });
      const sources = await host.call({
        capability: "music.sources.v1",
        method: "list",
        payload: null,
      });
      assert.equal(sources[0].executablePath, undefined);
      await host.source(sources[0].id);
      if (live) await host.fixtures([{ id: "music-bulb", role: "all", position: 0 }]);
    },
    async pump() {
      for (let i = 0; i < 25; i++) {
        at += 20;
        frame++;
        probe.events.emit("update", {
          type: "level",
          generation: "a".repeat(32),
          endFrame: frame * 960,
          discontinuities: 0,
          rms: 0.2,
          signal: "signal",
          invalidSamples: 0,
          freshness: { verified: true, maxAgeMs: 0, stale: false },
          analysis: {
            valid: true,
            bandRms: [0.1, 0.1, 0.1],
            onset:
              frame % 25 === 0 ? { id: frame, detectedAtFrame: frame * 960, strength: 0.2 } : null,
          },
        });
        for (const tick of [...intervals]) tick();
        await flush();
      }
    },
  };
}

test("native lighting controls need no package or worker and reject sandbox/cross-origin grants", async (t) => {
  const e = await environment(t);
  assert.equal((await e.http("/api/music-to-light/operator")).status, 200);
  assert.deepEqual(e.host.view().status.permissions, { capture: false, output: false });
  assert.equal(e.host.view().autoRaveEnabled, false);
  assert.equal(e.captures, 0);
  for (const origin of ["null", "https://untrusted.example"])
    assert.equal(
      (
        await e.http(
          "/api/music-to-light/permissions",
          "PUT",
          { value: { capture: true, output: true } },
          origin,
        )
      ).status,
      403,
    );
  assert.ok(!JSON.stringify(e.host.view()).includes("private-credential"));
  await assert.rejects(
    e.call("music.session.v1", "start", { mode: "preview", seconds: 2 }),
    /music_capture_permission_required/,
  );
  await e.select();
  assert.equal(
    (
      await e.http("/api/music-to-light/call", "POST", {
        capability: "music.session.v1",
        method: "start",
        payload: { mode: "preview", seconds: 2, owner: "other" },
      })
    ).status,
    400,
  );
  await e.call("music.session.v1", "start", { mode: "preview", seconds: 2 });
  await e.pump();
  assert.deepEqual(e.native, e.baseline);
  assert.ok((await e.call("music.session.v1", "status")).session.lastPreview);
  assert.equal(
    (
      await e.http("/api/music-to-light/permissions", "PUT", {
        value: { capture: false, output: false },
      })
    ).status,
    200,
  );
  assert.equal(e.stops, 1);
  assert.equal(e.intervals.size, 0);
});

test("native lighting shutdown awaits capture and fixture restoration", async (t) => {
  const e = await environment(t);
  await e.select(true);
  await e.call("music.session.v1", "start", { mode: "live", seconds: 2 });
  await e.pump();
  assert.equal(e.native.on, true);
  await e.host.shutdown();
  assert.deepEqual(e.native, e.baseline);
  assert.equal(e.stops, 1);
  await assert.rejects(
    e.call("music.session.v1", "start", { mode: "preview", seconds: 2 }),
    /music_feature_inactive/,
  );
});

test("Core-only lifecycle owns capture cleanup without any optional feature loader", async (t) => {
  const createCore = require("../src/app/core/create-core-server");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-native-owner-"));
  let stopped = 0,
    finish;
  const core = createCore({
    runtimeDir: root,
    dryRun: true,
    musicControllerOptions: {
      probeApi: {
        available: () => true,
        listSources: async () => [
          { id: "process:10:20", label: "Test player", kind: "application", scope: "process_tree" },
        ],
        capture: () => ({
          events: new EventEmitter(),
          done: new Promise((resolve) => {
            finish = resolve;
          }),
          snapshot: () => ({ generation: "a".repeat(32) }),
          stop() {
            stopped++;
            finish({});
          },
        }),
      },
    },
  });
  t.after(async () => {
    await core.services.lifecycle.stopAll();
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    fs.rmSync(root, { recursive: true, force: true });
  });
  assert.equal(core.extension, null);
  const music = core.services.musicToLight;
  await music.permissions({ capture: true, output: false });
  await music.call({ capability: "music.sources.v1", method: "list", payload: null });
  await music.source("process:10:20");
  await music.call({
    capability: "music.session.v1",
    method: "start",
    payload: { mode: "preview", seconds: 2 },
  });
  const results = await core.services.lifecycle.stopAll();
  assert.equal(results.find((row) => row.id === "music-to-light").ok, true);
  assert.ok(
    results.findIndex((row) => row.id === "music-to-light") <
      results.findIndex((row) => row.id === "hue-wiz-adapters"),
  );
  assert.equal(stopped, 1);
});

test("portable design persists without grants/bindings and invalid stored data is rejected", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-music-design-")),
    file = path.join(root, "design.json");
  t.after(() => {
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const first = createHost({ designPath: file });
  await first.call({
    capability: "music.styles.v1",
    method: "configure",
    payload: { palette: ["#123456"], preset: "pulse", warmCoolColors: true },
  });
  await first.shutdown();
  const second = createHost({ designPath: file });
  assert.deepEqual(second.view().design.palette, ["#123456"]);
  assert.equal(second.view().design.warmCoolColors, true);
  assert.deepEqual(second.view().status.permissions, { capture: false, output: false });
  assert.deepEqual(second.view().bindings, {
    source: null,
    sources: [null, null, null],
    fixtures: [],
  });
  assert.equal(JSON.parse(fs.readFileSync(file)).source, undefined);
  await second.shutdown();
  fs.writeFileSync(file, JSON.stringify({ palette: ["#123456"], source: "private-binding" }));
  const invalid = createHost({ designPath: file });
  assert.equal(invalid.view().designRecovered, true);
  assert.notEqual(invalid.view().design.palette[0], "#123456");
  await invalid.shutdown();
});

test("a missing saved light cannot erase the remembered application on restart", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-source-restore-"));
  const file = path.join(root, "operator.json");
  t.after(() => {
    const relative = path.relative(os.tmpdir(), root);
    assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const applicationSources = require("../integrations/music-to-light/application-sources.cjs");
  const identity = { image: "C:\\ExamplePlayer\\player.exe" };
  const source = {
    id: applicationSources.key(identity),
    label: "Example player",
    kind: "application",
    scope: "process_tree",
  };
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      source: { version: 1, source, identity },
      permissions: { capture: true, output: true },
      fixtures: [{ id: "removed-light", role: "all", position: 0 }],
    }),
  );
  let captures = 0;
  const options = () => ({
    operatorPath: file,
    controllerOptions: {
      probeApi: applicationSources({
        native: {
          available: () => true,
          applicationCatalog: async () => ({ processes: [], sources: [] }),
          capture() {
            captures++;
            throw Error("unexpected_capture");
          },
        },
      }),
    },
  });
  const first = createHost(options());
  assert.equal(first.view().bindings.source.id, source.id);
  assert.deepEqual(first.view().status.permissions, { capture: true, output: true });
  assert.deepEqual(first.view().bindings.fixtures, []);
  assert.equal(first.view().operatorRecovered, true);
  await first.permissions({ capture: true, output: false });
  await first.shutdown();
  const second = createHost(options());
  assert.equal(second.view().bindings.source.id, source.id);
  assert.equal(second.view().operatorRecovered, false);
  assert.equal(captures, 0);
  await second.shutdown();
});

test("large source response fails with a bounded error and leaves native controls available", async (t) => {
  const sources = Array.from({ length: 200 }, (_, index) => ({
    id: `process:${index + 1}:20`,
    label: "p".repeat(260),
    kind: "application",
    scope: "process_tree",
  }));
  const e = await environment(t, sources);
  await e.host.permissions({ capture: true, output: false });
  await assert.rejects(e.call("music.sources.v1", "list"), /music_response_too_large/);
  assert.equal((await e.call("music.session.v1", "status")).state, "idle");
});

test("all three source slots persist privately across restart, including an unselected main slot", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-source-slots-")),
    operatorPath = path.join(root, "operator.json");
  t.after(() => {
    const relative = path.relative(os.tmpdir(), root);
    assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const createApps = require("../integrations/music-to-light/application-sources.cjs");
  const processes = [10, 20, 30].map((pid) => ({
    pid,
    parent: 0,
    created: String(pid * 10),
    image: `C:\\Test${pid}\\player.exe`,
    package: "",
  }));
  let queries = 0;
  const native = {
    available: () => true,
    applicationCatalog: async () => {
      queries++;
      return {
        processes,
        sources: processes.map((p) => ({
          id: `process:${p.pid}:${p.created}`,
          label: "Test app",
          kind: "application",
          scope: "process_tree",
        })),
      };
    },
  };
  const options = () => ({ operatorPath, controllerOptions: { probeApi: createApps({ native }) } });
  const first = createHost(options());
  await first.permissions({ capture: true, output: false });
  const choices = await first.call({
    capability: "music.sources.v1",
    method: "list",
    payload: null,
  });
  await first.sources([null, choices[1].id, choices[2].id]);
  assert.equal(first.view().bindings.sources[0], null);
  await first.shutdown();
  const queried = queries,
    second = createHost(options());
  assert.equal(queries, queried, "restart does not enumerate or capture audio");
  assert.deepEqual(
    second.view().bindings.sources.map((s) => s?.id || null),
    [null, choices[1].id, choices[2].id],
  );
  assert.equal(second.view().operatorRecovered, false);
  assert.equal(second.view().status.sourceSelected, true);
  await assert.rejects(
    second.sources([choices[1].id, choices[1].id, null]),
    /invalid_music_source_priorities/,
  );
  await second.sources([null, null, null]);
  assert.equal(second.view().status.sourceSelected, false);
  await second.shutdown();
});

test("native tab browser flow previews and drives simulated lights at desktop and phone widths", async (t) => {
  const { chromium } = require("playwright");
  if (!fs.existsSync(chromium.executablePath())) {
    t.skip("optional browser binary unavailable");
    return;
  }
  const e = await environment(t),
    browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Partial startup must recover without a reload or duplicate look controls.
  for (const endpoint of ["catalog", "effects"]) {
    let attempts = 0;
    await page.route(`**/api/music-to-light/${endpoint}`, (route) =>
      ++attempts === 1
        ? route.fulfill({ status: 503, json: { ok: false, error: "temporarily_unavailable" } })
        : route.continue(),
    );
  }
  await page.goto(e.base + "/");
  await page.locator('[data-tab="lights"]').click();
  await page.locator('[data-light-tab="music"]').click();
  await page.waitForFunction(() =>
    document.getElementById("music-helperStatus").textContent.includes("ready"),
  );
  assert.equal(await page.locator('[data-light-panel="music"] iframe').count(), 0);
  assert.equal(await page.locator("#music-preview").isDisabled(), true);
  await page.waitForFunction(() => document.getElementById("music-look").options.length >= 6);
  await page.waitForFunction(() => !document.getElementById("music-look").disabled);
  const startingDesign = structuredClone(e.host.view().design);
  await e.call("music.styles.v1", "configure", {
    ...startingDesign,
    outputHz: 16,
    outputRateMode: "adaptive",
    behaviors: { ...startingDesign.behaviors, literalAttackMs: 45, colorBlendMs: 410 },
  });
  await page.waitForFunction(() => document.getElementById("music-quickRise").value === "45");
  await page.locator("#music-quickRise").evaluate((input) => {
    input.value = "70";
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await waitFor(() => e.host.view().design.behaviors.literalAttackMs === 70);
  assert.equal(await page.locator("#music-intensity, #music-songIntensity").count(), 0);
  assert.equal(e.host.view().design.intensity, 1);
  assert.equal(e.host.view().design.outputHz, 12);
  assert.equal(await page.locator('#music-outputHz option[value="16"]').count(), 0);
  assert.equal(
    e.host.view().design.behaviors.colorBlendMs,
    410,
    "a later UI edit must retain settings received from another client",
  );
  await e.call("music.styles.v1", "configure", startingDesign);
  const mixerReference = {
    key: "test-mixer",
    systemPercent: 50,
    systemDb: -12,
    appGain: 0.2,
    muted: false,
  };
  await e.call("music.styles.v1", "configure", {
    ...startingDesign,
    floorDb: -50,
    ceilingDb: -26,
    calibrationVolume: mixerReference,
  });
  await page.evaluate(
    ({ floor, ceiling }) => {
      document.getElementById("music-floorDb").value = floor;
      document.getElementById("music-ceilingDb").value = ceiling;
    },
    { floor: startingDesign.floorDb, ceiling: startingDesign.ceilingDb },
  );
  await page.locator("#music-quickRelease").evaluate((input) => {
    input.value = "250";
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await waitFor(() => e.host.view().design.behaviors.literalReleaseMs === 250);
  assert.equal(
    e.host.view().design.floorDb,
    -50,
    "ordinary edits retain the current calibration, even with stale reference inputs",
  );
  assert.equal(e.host.view().design.ceilingDb, -26);
  assert.deepEqual(e.host.view().design.calibrationVolume, mixerReference);
  await e.call("music.styles.v1", "configure", startingDesign);
  await page.waitForFunction(
    (value) => document.getElementById("music-quickRise").value === value,
    String(startingDesign.behaviors.literalAttackMs),
  );
  const catalog = await fetch(e.base + "/api/music-to-light/catalog").then((r) => r.json());
  assert.equal(await page.locator("#music-look option").count(), catalog.value.looks.length + 1);
  assert.equal(await page.locator("#music-catalogPanel").evaluate((el) => el.open), false);
  assert.equal(await page.locator(".musicNavigation button").count(), 4);
  assert.equal(await page.locator("#music-tuning").evaluate((el) => el.open), true);
  assert.equal(await page.locator("#music-lookCards").isVisible(), true);
  assert.equal(await page.locator("#music-palette").isVisible(), true);

  for (const count of [4, 5, 6, 7, 8]) {
    await page.locator("#music-addColor").click();
    await page.waitForFunction(
      (expected) =>
        document.getElementById("music-palette").children.length === expected &&
        !document.getElementById("music-look").disabled,
      count,
    );
    await waitFor(() => e.host.view().design.palette.length === count).catch(async (error) => {
      throw new Error(
        `Palette addition to ${count}: ${await page.locator("#music-notice").textContent()}; saved ${e.host.view().design.palette.length}; browser errors ${errors.join(", ")}`,
        { cause: error },
      );
    });
  }
  assert.equal(await page.locator("#music-addColor").isDisabled(), true);
  for (const count of [7, 6, 5, 4, 3, 2]) {
    await page.locator("#music-palette button").last().click();
    await page
      .waitForFunction(
        (expected) =>
          document.getElementById("music-palette").children.length === expected &&
          !document.getElementById("music-look").disabled,
        count,
      )
      .catch(async (error) => {
        throw new Error(
          `Palette removal to ${count}: ${await page.locator("#music-notice").textContent()}; ${JSON.stringify(e.host.view().design.palette)}`,
          { cause: error },
        );
      });
    await waitFor(() => e.host.view().design.palette.length === count);
  }
  assert.equal(await page.locator("#music-palette button").first().isDisabled(), true);
  assert.equal(e.host.view().design.palette.length, 2);
  await page.locator('.musicNavigation [data-music-view-target="create"]').click();
  await page.locator(".musicGroupsPanel > details > summary").click();
  await page.locator("#music-warmCoolColors").check();
  await waitFor(() => e.host.view().design.warmCoolColors);
  await page.locator('.musicNavigation [data-music-view-target="play"]').click();
  await page.locator("#music-moreLooks > summary").click();
  await page.locator('[data-look="aurora-swell"]').click();
  await page.waitForFunction(
    () =>
      !document.getElementById("music-live").disabled ||
      !document.getElementById("music-look").disabled,
  );
  assert.equal(e.host.view().design.behaviors.expressiveEnabled, false);
  assert.equal(e.host.view().design.warmCoolColors, true);
  assert.equal(e.host.view().design.interpretation, "literal");
  assert.deepEqual(e.host.view().design.parameterRanges, {});
  await page.screenshot({
    path: path.resolve(__dirname, "../runtime/music-play-workspace.png"),
    fullPage: true,
  });
  const openWorkspace = async (name) =>
    page
      .locator(
        '.musicNavigation [data-music-view-target="' +
          (name === "customize" ? "create" : name) +
          '"]',
      )
      .click();
  await page.locator("[data-music-calibration-shortcut]").click();
  assert.equal(await page.locator("#music-lookCards").isVisible(), false);
  assert.equal(await page.locator("#music-source").isVisible(), true);
  assert.equal(await page.locator("#music-calibrate").isVisible(), true);
  assert.equal(e.captures, 0, "opening calibration never starts capture");
  await page.locator("#music-autoAudioFollow").check();
  await waitFor(() => e.host.view().design.autoAudioFollow);
  const previousLimit = e.host.view().design.maximumBrightness;
  assert.equal(await page.locator("#music-calibrationSeconds").inputValue(), "30");
  assert.equal(await page.locator("#music-calibrationHeadroom").inputValue(), "0");
  await page.locator("#music-calibrationSummary").click();
  await page.locator("#music-calibrationSeconds").selectOption("60");
  await page.locator("#music-calibrationHeadroom").selectOption("6");
  assert.ok(
    (await page.locator("#music-calibrationSummary").textContent()).includes(
      "60 seconds with 6 dB",
    ),
  );
  await page.locator("#music-calibrationSeconds").selectOption("30");
  await page.locator("#music-calibrationHeadroom").selectOption("3");
  await page.locator("#music-calibrationSummary").click();
  await openWorkspace("play");
  await page.locator("#music-moreLooks").evaluate((node) => {
    node.open = true;
  });
  await page.locator('[data-look="electric-pulse"]').click();
  await waitFor(
    () =>
      JSON.stringify(e.host.view().design.palette) ===
      JSON.stringify(["#ff075b", "#7024ff", "#008cff"]),
  );
  await page.waitForFunction(() =>
    document.getElementById("music-lookHelp").textContent.includes("Apply this palette"),
  );
  assert.deepEqual(e.host.view().design.palette, ["#ff075b", "#7024ff", "#008cff"]);
  assert.equal(e.host.view().design.behaviors.colorVibrance, 1);
  assert.equal(e.host.view().design.maximumBrightness, previousLimit);
  assert.equal(e.host.view().status.permissions.capture, false);
  assert.equal(e.captures, 0, "choosing a composition grants no capture or fixture access");
  await openWorkspace("play");
  await page.locator('[data-look="rave-mix"]').click();
  await page.waitForFunction(() => !document.getElementById("music-applyDesign").disabled);
  assert.equal(e.host.view().design.recipeOptions.shape.value, "unison");
  assert.equal(await page.locator("#music-recipeMode-shape").count(), 0);
  assert.equal(await page.locator("#music-preset option").count(), 1);
  assert.equal(
    await page.locator("#music-recipeAllow-effect-wash, #music-recipeAllow-effect-bands").count(),
    0,
  );
  await openWorkspace("play");
  await page.locator('[data-look="smooth-reference"]').click();
  await page.waitForFunction(() => !document.getElementById("music-applyDesign").disabled);
  assert.equal(e.host.view().design.recipeOptions.shape.value, "unison");
  assert.equal(e.host.view().design.recipeOptions.shape.mode, "fixed");
  assert.equal(e.host.view().design.maximumBrightness, previousLimit);
  await openWorkspace("play");
  await page.locator("#music-moreLooks").evaluate((node) => {
    node.open = true;
  });
  await page.locator('[data-look="electric-pulse"]').click();
  await page.waitForFunction(() => !document.getElementById("music-applyDesign").disabled);
  assert.equal(e.host.view().design.scenarioMode, "manual");
  assert.equal(e.host.view().design.recipeOptions.shape.value, "unison");
  await openWorkspace("setup");
  await page.locator("#music-outputHz").selectOption("12");
  await page.waitForFunction(() => !document.getElementById("music-applyDesign").disabled);
  assert.equal(e.host.view().design.outputHz, 12);
  await openWorkspace("setup");
  await page.locator("#music-outputRateMode").selectOption("adaptive");
  await page.waitForFunction(() => !document.getElementById("music-applyDesign").disabled);
  assert.equal(e.host.view().design.outputRateMode, "adaptive");
  await openWorkspace("setup");
  await page.locator("#music-outputCeiling").fill("100");
  await openWorkspace("setup");
  await page.locator("#music-outputCeiling").dispatchEvent("input");
  await openWorkspace("setup");
  await page.locator("#music-outputCeiling").dispatchEvent("change");
  await page.waitForFunction(
    () => document.getElementById("music-outputCeilingValue").value === "100%",
  );
  await page.waitForFunction(() => !document.getElementById("music-applyDesign").disabled);
  assert.equal(e.host.view().design.maximumBrightness, 100);
  await openWorkspace("setup");
  await page.locator("#music-outputCeiling").fill(String(previousLimit));
  await openWorkspace("setup");
  await page.locator("#music-outputCeiling").dispatchEvent("input");
  await openWorkspace("setup");
  await page.locator("#music-outputCeiling").dispatchEvent("change");
  await page.waitForFunction(() => !document.getElementById("music-applyDesign").disabled);
  await openWorkspace("setup");
  await page.locator("#music-capturePermission").check();
  await openWorkspace("setup");
  await page.locator("#music-refreshSources").click();
  await page.waitForFunction(() => document.getElementById("music-source").options.length === 2);
  await openWorkspace("setup");
  await page.locator("#music-source").selectOption("process:10:20");
  e.advanceClock(31000);
  await assert.rejects(e.host.source("process:10:20"), /music_source_not_in_current_catalog/);
  await openWorkspace("setup");
  await page.locator("#music-selectSource").click();
  await page.waitForFunction(() => !document.getElementById("music-preview").disabled);
  await page.locator("#music-refreshSources").click();
  await page.waitForFunction(() => !document.getElementById("music-refreshSources").disabled);
  assert.equal(await page.locator("#music-source").inputValue(), "process:10:20");
  e.setSourceRows([]);
  await page.locator("#music-refreshSources").click();
  await page.waitForFunction(() => !document.getElementById("music-refreshSources").disabled);
  assert.equal(await page.locator("#music-source").inputValue(), "process:10:20");
  assert((await page.locator("#music-source option:checked").textContent()).includes("remembered"));
  e.setSourceRows(undefined);
  await page.reload();
  await page.locator('[data-tab="lights"]').click();
  await page.locator('[data-light-tab="music"]').click();
  await page.waitForFunction(
    () => document.querySelectorAll("#music-lookCards [data-look]").length >= 6,
  );
  await openWorkspace("setup");
  assert.equal(await page.locator("#music-source").inputValue(), "process:10:20");
  await openWorkspace("play");
  await page.locator("#music-moreLooks").evaluate((node) => {
    node.open = true;
  });
  await page.locator('[data-look="electric-pulse"]').click();
  await page.waitForFunction(() => !document.getElementById("music-look").disabled);
  await openWorkspace("play");
  await page.locator("#music-preview").click();
  await page.waitForFunction(() =>
    document.getElementById("music-sessionStatus").textContent.includes("Waiting"),
  );
  await e.pump();
  await page.locator(".musicSwatch").first().waitFor();
  assert.equal(await page.locator(".musicSwatch").count(), 4);
  assert.deepEqual(e.native, e.baseline);
  await page.screenshot({
    path: path.resolve(__dirname, "../runtime/music-native-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({
    path: path.resolve(__dirname, "../runtime/music-native-mobile.png"),
    fullPage: true,
  });
  await openWorkspace("play");
  await openWorkspace("create");
  await page.locator("#music-savedEffectName").fill("Browser favourite");
  await page.locator("#music-saveCurrentEffect").click();
  await page.waitForFunction(() =>
    document.getElementById("music-savedEffectsStatus").textContent.includes("1 saved"),
  );
  await page.locator("#music-savedEffectMode").selectOption("single");
  await page.locator("#music-applySavedEffectPolicy").click();
  await page.waitForFunction(
    () =>
      document.getElementById("music-savedEffectMode").value === "single" &&
      document.getElementById("music-savedEffectsStatus").textContent.includes("Changes apply"),
  );
  assert.equal(e.host.effects().policy.mode, "single");
  await page.waitForFunction(() => !document.getElementById("music-savedPlaybackNotice").hidden);
  await page.locator("#music-savedEffectMode").selectOption("saved-random");
  await page.locator("#music-savedEffectPool input").check();
  await page.locator("#music-applySavedEffectPolicy").click();
  await waitFor(() => e.host.effects().policy.mode === "saved-random");
  await openWorkspace("play");
  await page.locator("#music-useCurrentProfile").click();
  await waitFor(() => e.host.effects().policy.mode === "full-random");
  await page.waitForFunction(() => document.getElementById("music-savedPlaybackNotice").hidden);
  await page.locator("#music-stop").click();
  await page.waitForFunction(() => !document.getElementById("music-preview").disabled);
  await openWorkspace("setup");
  await page.locator("#music-outputPermission").check();
  await page.waitForFunction(() => !document.getElementById("music-saveFixtures").disabled);
  await page.locator('.musicFixture input[type="checkbox"]').check();
  await openWorkspace("setup");
  await page.locator('[data-route-field="raveBehavior"]').selectOption("dim");
  await openWorkspace("setup");
  await page.locator('[data-route-field="sceneBrightness"]').fill("10");
  await openWorkspace("setup");
  await page.locator("#music-saveFixtures").click();
  await page.waitForFunction(() => !document.getElementById("music-live").disabled);
  await openWorkspace("play");
  await page.locator("#music-live").click();
  await page.waitForFunction(() =>
    document.getElementById("music-sessionStatus").textContent.includes("Waiting"),
  );
  await e.pump();
  await page.waitForFunction(() =>
    document.getElementById("music-sessionStatus").textContent.includes("Live lighting"),
  );
  assert.equal(
    e.native.on,
    false,
    "a theatre route keeps an already-off fixture off during manual playback",
  );
  await openWorkspace("library");
  await page.locator("#music-recipeEditor > summary").click();
  await page.locator("#music-raveEnabled").check();
  await page.waitForFunction(() => !document.getElementById("music-raveDurationMode").disabled);
  await page.locator("#music-raveDurationMode").selectOption("separate");
  await page.waitForFunction(() => !document.getElementById("music-raveSeconds").disabled);
  await page.locator("#music-raveSeconds").fill("8");
  await page.locator("#music-raveSeconds").dispatchEvent("change");
  await page.waitForFunction(() => !document.getElementById("music-raveColorPlan").disabled);
  await page.locator("#music-raveColorPlan").selectOption("frequency");
  await page.waitForFunction(() => !document.getElementById("music-raveColorPlan").disabled);
  await e.call("music.styles.v1", "configure", {
    ...e.host.view().design,
    scenarioWeights: { pulse: 1, wave: 0, bounce: 0, handoff: 0 },
    raveLayerMode: "fixed",
  });
  const captures = e.captures;
  await e.host.rave({ fixtureIds: ["music-bulb"], seconds: 5 });
  assert.equal(e.host.view().status.duration.mode, "separate");
  assert.equal(e.host.view().status.duration.remainingSeconds, 8);
  await e.pump();
  await page.waitForFunction(() =>
    document.getElementById("music-pipelineTitle").textContent.includes("Color-led audio"),
  );
  await page.waitForFunction(
    () => document.getElementById("music-assignmentDetails").children.length > 0,
  );
  await page.evaluate(() => {
    globalThis.assignmentBeforePoll = document.getElementById("music-assignmentDetails").firstChild;
  });
  await page.waitForTimeout(1100);
  assert.equal(
    await page.evaluate(
      () =>
        globalThis.assignmentBeforePoll ===
        document.getElementById("music-assignmentDetails").firstChild,
    ),
    true,
    "unchanged assignment rows retain their DOM and hover state across pipeline polls",
  );
  assert.equal(
    e.captures,
    captures,
    "viewer rave borrows capture instead of launching another helper",
  );
  await page.setViewportSize({ width: 1280, height: 960 });
  await openWorkspace("customize");
  await page.locator("#music-recipeEditor").evaluate((el) => {
    el.open = false;
  });
  await page.locator("#music-catalogPanel > summary").click();
  await page
    .locator("#music-catalogPanel")
    .screenshot({ path: path.resolve(__dirname, "../runtime/music-scenario-controls.png") });
  await openWorkspace("customize");
  await page.locator("#music-behavior-colorEnabled").uncheck();
  await page.waitForFunction(
    () => document.getElementById("music-active-colorEnabled").textContent === "Blocked",
  );
  await openWorkspace("customize");
  await e.call("music.styles.v1", "configure", {
    ...e.host.view().design,
    scenarioWeights: { pulse: 0, wave: 0, bounce: 0, handoff: 0 },
  });
  await waitFor(() => e.host.raveIds().length === 0);
  await e.pump();
  assert.equal(
    e.host.view().status.state,
    "running",
    "blocking the viewer scenario restores continuous music",
  );
  await page.locator("#music-stop").click();
  await page.waitForFunction(() => !document.getElementById("music-preview").disabled);
  assert.deepEqual(e.native, e.baseline);
  let rediscoveryRequests = 0;
  await page.route("**/api/music-to-light/call", async (route) => {
    const body = route.request().postDataJSON();
    if (body.capability === "music.sources.v1") {
      rediscoveryRequests++;
      return route.fulfill({ json: { ok: true, value: [] } });
    }
    return route.continue();
  });
  await openWorkspace("setup");
  await page.locator("#music-selectSource").click();
  await page.waitForFunction(() =>
    document.getElementById("music-sourceStatus").textContent.includes("already remembered"),
  );
  assert.equal(
    rediscoveryRequests,
    0,
    "remembered selection must not depend on an idle audio catalog",
  );
  assert.equal(e.host.view().bindings.source.id, "process:10:20");
  await openWorkspace("create");
  await page.locator("#music-transitions").evaluate((el) => {
    el.open = true;
  });
  assert.equal(await page.locator("#music-behavior-openingStyle option").count(), 5);
  assert.equal(await page.locator("#music-behavior-endingStyle option").count(), 5);
  await page.locator("#music-behavior-openingStyle").selectOption("4");
  await page.locator("#music-behavior-endingStyle").selectOption("3");
  await page.locator("#music-applyTransitions").click();
  await page.waitForFunction(() => !document.getElementById("music-applyTransitions").disabled);
  assert.equal(e.host.view().design.behaviors.openingStyle, 4);
  assert.equal(e.host.view().design.behaviors.endingStyle, 3);
  await page
    .locator("#music-transitions")
    .screenshot({ path: path.resolve(__dirname, "../runtime/music-transition-controls.png") });
  await page.route("**/api/music-to-light/catalog", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ json: { ...data, value: { ...data.value, revision: 12 } } });
  });
  await page.reload();
  await page.locator('[data-tab="lights"]').click();
  await page.locator('[data-light-tab="music"]').click();
  await page.waitForFunction(() =>
    document.getElementById("music-notice").textContent.includes("older music code"),
  );
  assert.equal(await page.locator("#music-notice").isVisible(), true);
  assert.equal(await page.locator("#music-preview").isDisabled(), true);
  assert.deepEqual(errors, []);
});

test("saved effects HTTP routes capture actual combinations, validate pools and enforce local operator access", async (t) => {
  const e = await environment(t);
  await e.select();
  await e.call("music.session.v1", "start", { mode: "preview", seconds: 2 });
  await e.pump();
  const rejected = await e.http(
    "/api/music-to-light/effects/save",
    "POST",
    { name: "Untrusted" },
    "https://untrusted.example",
  );
  assert.equal(rejected.status, 403);
  const response = await e.http("/api/music-to-light/effects/save", "POST", {
    name: "Local favourite",
  });
  assert.equal(response.status, 200);
  const saved = (await response.json()).value;
  assert.equal(
    (await e.http("/api/music-to-light/effects/policy", "POST", { mode: "saved-random", ids: [] }))
      .status,
    400,
  );
  assert.equal(
    (
      await e.http("/api/music-to-light/effects/policy", "POST", {
        mode: "single",
        ids: [saved.id],
      })
    ).status,
    200,
  );
  assert.equal(
    (await e.http("/api/music-to-light/effects/delete", "POST", { id: saved.id })).status,
    400,
  );
  await e.call("music.session.v1", "stop");
  await e.call("music.session.v1", "start", { mode: "preview", seconds: 2 });
  await e.pump();
  assert.equal(e.host.pipeline().savedEffect.name, "Local favourite");
  await e.call("music.session.v1", "stop");
  assert.equal(
    (await e.http("/api/music-to-light/effects/policy", "POST", { mode: "full-random", ids: [] }))
      .status,
    200,
  );
  assert.equal(
    (await e.http("/api/music-to-light/effects/delete", "POST", { id: saved.id })).status,
    200,
  );
  assert.equal(e.host.effects().profiles.length, 0);
});

test("song library routes reject foreign origins and Auto-Rave follows a song without viewer routes", async (t) => {
  let title = "Saved track";
  const e = await environment(
    t,
    [{ id: "process:10:20", label: "TIDAL", kind: "application", scope: "process_tree" }],
    async () => ({
      primary: {
        provider: "tidal",
        title,
        artists: ["Artist"],
        observedAt: Date.now(),
        positionMs: 1000,
        durationMs: 180000,
        status: "playing",
      },
    }),
  );
  const foreign = await e.http(
    "/api/music-to-light/songs/save",
    "POST",
    { title, artist: "Artist" },
    "https://untrusted.example",
  );
  assert.equal(foreign.status, 403);
  assert.equal(
    (await e.http("/api/music-to-light/songs/save", "POST", { title, artist: "Artist" })).status,
    200,
  );
  await e.select(true);
  await e.call("music.styles.v1", "configure", { ...e.host.view().design, raveEnabled: true });
  await e.host.songPolicy({ enabled: true });
  assert.equal(e.host.view().autoRaveEnabled, true);
  await waitFor(() => e.captures === 1);
  assert.equal((await e.host.library()).rave.origin, "auto");
  await e.pump();
  await e.call("music.session.v1", "stop");
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(e.captures, 1, "Stop must not immediately restart the same song");
  assert.equal((await e.host.library()).rave, null);
  title = "Different track";
  await e.host.songPolicy({ enabled: false });
  assert.equal(e.host.view().autoRaveEnabled, false);
});

test("diagnostics opens real editors and color timing follows effective fixture jobs", async (t) => {
  const { chromium } = require("playwright");
  if (!fs.existsSync(chromium.executablePath())) {
    t.skip("optional browser binary unavailable");
    return;
  }
  const e = await environment(t),
    browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(e.base + "/");
  await page.locator('[data-tab="lights"]').click();
  await page.locator('[data-light-tab="music"]').click();
  await page.waitForFunction(() => !document.getElementById("music-fixtureRandomization").disabled);
  assert.equal(
    await page
      .locator("#music-behaviorControls > details")
      .evaluateAll((panels) => panels.every((panel) => panel.querySelector("input,select"))),
    true,
    "advanced controls must not contain empty editors",
  );
  for (const id of [
    "analysis",
    "shape",
    "response",
    "layers",
    "scenario",
    "color",
    "output",
    "source",
  ]) {
    await page.getByRole("button", { name: "Audio & lights", exact: true }).click();
    await page.locator("#music-diagnostics").evaluate((node) => {
      node.open = true;
    });
    await page.locator('#music-pipeline button[data-stage="' + id + '"]').click();
    if (id === "shape") assert(await page.locator("#music-arrangement").isVisible());
    if (id === "response")
      assert(await page.locator("#music-behavior-literalAttackMs").isVisible());
  }
  const fixed = (value) => ({ mode: "fixed", value, allowed: [value] });
  const configure = (changes) =>
    e.call("music.styles.v1", "configure", {
      ...e.host.view().design,
      ...changes,
    });
  await configure({ colorMode: "fixed", recipeOptions: { color: fixed("travel") } });
  await page.waitForFunction(
    () =>
      !document.getElementById("music-colorSeconds").disabled &&
      !document.getElementById("music-behavior-colorVibrance").disabled,
  );
  await configure({ colorMode: "onsets", recipeOptions: { color: fixed("fixed") } });
  await page.waitForFunction(
    () =>
      document.getElementById("music-colorSeconds").disabled &&
      document.getElementById("music-behavior-colorVibrance").disabled &&
      document.getElementById("music-behavior-colorBlendMs").disabled,
  );
  await configure({ recipeOptions: { effect: fixed("wave") } });
  await page.waitForFunction(
    () =>
      document.getElementById("music-colorSeconds").disabled &&
      !document.getElementById("music-behavior-colorVibrance").disabled &&
      !document.getElementById("music-behavior-colorBlendMs").disabled,
  );
  await configure({ recipeOptions: { effect: fixed("handoff") } });
  await page.waitForFunction(
    () =>
      !document.getElementById("music-colorSeconds").disabled &&
      document.getElementById("music-behavior-colorBlendMs").disabled,
  );
  await configure({ warmCoolColors: true });
  await page.waitForFunction(
    () =>
      document.getElementById("music-colorSeconds").disabled &&
      document.getElementById("music-behavior-colorVibrance").disabled &&
      !document.getElementById("music-behavior-colorBlendMs").disabled,
  );
  assert.equal(e.captures, 0, "editing and diagnostics cannot start capture");
  assert.deepEqual(errors, []);
});

test("Play selects profiles; Create edits effects; Audio & lights owns setup; Automation edits songs and approvals", async (t) => {
  const { chromium } = require("playwright");
  if (!fs.existsSync(chromium.executablePath())) {
    t.skip("optional browser binary unavailable");
    return;
  }
  const e = await environment(t),
    browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(e.base + "/");
  await page.locator('[data-tab="lights"]').click();
  await page.locator('[data-light-tab="music"]').click();
  await page.waitForFunction(() => !document.getElementById("music-fixtureRandomization").disabled);
  const choose = async (id, value) =>
    page.locator("#music-" + id + ' + div button[data-value="' + value + '"]').click();
  assert.equal(
    await page.getByRole("button", { name: "Play", exact: true }).getAttribute("aria-pressed"),
    "true",
  );
  const colorsBeforeAssignments = e.host.view().design.palette;
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await choose("fixtureRandomization", "coordinated");
  await waitFor(() => e.host.view().design.recipeOptions.role?.mode === "random");
  assert.equal(e.host.view().design.recipeOptions.task.mode, "configured");
  await page.waitForFunction(() => !document.getElementById("music-fixtureRandomization").disabled);
  await choose("fixtureRandomization", "mixed");
  await waitFor(() => e.host.view().design.recipeOptions.effect?.mode === "random");
  assert.deepEqual(e.host.view().design.palette, colorsBeforeAssignments);
  assert.equal(e.captures, 0, "assignment edits never start capture");
  await page.waitForFunction(() => !document.getElementById("music-paletteGrouping").disabled);
  await choose("paletteGrouping", "effects");
  await waitFor(() => e.host.view().design.recipeOptions.paletteScope?.value === "effects");
  assert.equal(e.host.view().design.recipeOptions.effect.mode, "random");
  assert.deepEqual(e.host.view().design.palette, colorsBeforeAssignments);
  await page.waitForFunction(() => !document.getElementById("music-paletteGrouping").disabled);
  await choose("paletteGrouping", "fixtures");
  await waitFor(() => e.host.view().design.recipeOptions.paletteScope?.value === "fixtures");
  await page.waitForFunction(() => !document.getElementById("music-paletteGrouping").disabled);
  await choose("paletteGrouping", "shared");
  await waitFor(() => e.host.view().design.recipeOptions.paletteScope?.value === "shared");
  await page.waitForFunction(() => !document.getElementById("music-fixtureRandomization").disabled);
  await choose("fixtureRandomization", "configured");
  await waitFor(() => e.host.view().design.recipeOptions.effect?.mode === "configured");
  await page.waitForFunction(() => !document.getElementById("music-fixtureRandomization").disabled);
  await page.getByRole("button", { name: "Audio & lights", exact: true }).click();
  await page.locator("#music-outputCeiling").fill("45");
  await page.locator("#music-outputCeiling").dispatchEvent("input");
  await page.locator("#music-outputCeiling").dispatchEvent("change");
  await waitFor(() => e.host.view().design.maximumBrightness === 45);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.locator("#music-responseAdjustments > summary").click();
  assert.equal(
    await page.locator("#music-quickBrightness, #music-quickAccent, #music-quickImpact").count(),
    0,
  );
  await page.locator("#music-quickRise").evaluate((input) => {
    input.value = "80";
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await waitFor(() => e.host.view().design.behaviors.literalAttackMs === 80);
  await page.waitForFunction(() => !document.getElementById("music-quickRelease").disabled);
  await page.locator("#music-quickRelease").evaluate((input) => {
    input.value = "160";
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await waitFor(() => e.host.view().design.behaviors.literalReleaseMs === 160);
  assert.equal(e.host.view().design.interpretation, "literal");
  assert.equal(e.host.view().design.behaviors.attacksEnabled, false);
  await page.getByRole("button", { name: "Audio & lights", exact: true }).click();
  await page.locator("#music-capturePermission").check();
  await waitFor(() => e.host.view().status.permissions.capture);
  await page.locator("#music-refreshSources").click();
  await page.locator('#music-source option[value="process:10:20"]').waitFor({ state: "attached" });
  await page.locator("#music-source").selectOption("process:10:20");
  await page.locator("#music-selectSource").click();
  await waitFor(() => e.host.view().bindings.source?.id === "process:10:20");
  await page.locator("#music-outputPermission").check();
  await page.locator('.musicFixture input[type="checkbox"]').check();
  await page.locator("#music-saveFixtures").click();
  await waitFor(() => e.host.view().bindings.fixtures.length === 1);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.locator(".musicGroupsPanel > details > summary").click();
  await page.waitForFunction(() => !document.getElementById("music-contrastAmount").disabled);
  await page.locator("#music-contrastAmount").evaluate((input) => {
    input.value = "40";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await waitFor(() => e.host.view().bindings.fixtures[0].outOfSync === 40);
  assert.equal(e.captures, 0, "contrast cannot start capture");
  await page.locator("#music-contrastScope").selectOption("selected");
  assert.equal(await page.locator("#music-contrastAmount").isDisabled(), true);
  await page.locator("#music-contrastLights button").click();
  await page.waitForFunction(() => !document.getElementById("music-contrastAmount").disabled);
  await page.locator("#music-contrastAmount").evaluate((input) => {
    input.value = "70";
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await waitFor(() => e.host.view().bindings.fixtures[0].outOfSync === 70);
  await page.waitForFunction(
    () => document.getElementById("music-contrastValue").textContent === "70%",
  );
  await page.locator("#music-contrastScope").selectOption("all");
  const customColors = [...e.host.view().design.palette];
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await choose("paletteSource", "generated");
  await waitFor(() => e.host.view().design.recipeOptions.palette?.allowed[0] === "generated");
  assert.deepEqual(e.host.view().design.palette, customColors);
  await page.locator("#music-palette").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.locator("#music-randomRules > summary").click();
  await choose("recipeMode-color", "fixed");
  await page.waitForFunction(() => !document.getElementById("music-recipePin-color").disabled);
  await choose("recipePin-color", "energy");
  await waitFor(() => e.host.view().design.recipeOptions.color?.value === "energy");
  await page.locator("#music-warmCoolColors").check();
  await waitFor(() => e.host.view().design.warmCoolColors);
  assert.equal(e.host.view().design.warmCoolColors, true);
  assert.equal(e.host.view().design.recipeOptions.color.mode, "fixed");
  assert.equal(e.captures, 0);
  await page.getByRole("button", { name: "Automation", exact: true }).click();
  await page.locator("#music-recipeEditor > summary").click();
  await page.locator("#music-raveEnabled").check();
  await page.waitForFunction(() => !document.getElementById("music-autoRave").disabled);
  await page.locator("#music-autoRave").check();
  await waitFor(async () => (await e.host.library()).enabled);
  await page.locator("#music-autoRave").uncheck();
  await waitFor(async () => !(await e.host.library()).enabled);
  await page.screenshot({
    path: path.resolve(__dirname, "../runtime/music-main-dashboard.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Automation", exact: true }).click();
  await page.locator("#music-songTitle").fill("Any song");
  await page.locator("#music-songArtist").fill("Any artist");
  await page.locator("#music-songSubmit").click();
  await page.locator("#music-songList strong", { hasText: "Any song" }).waitFor();
  assert.equal(e.captures, 0, "adding a song grants no capture");
  await page.locator("#music-songList").getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator("#music-songTitle").fill("Edited song");
  await page.locator("#music-songSubmit").click();
  await page.locator("#music-songList strong", { hasText: "Edited song" }).waitFor();
  await page.locator("#music-songList input[type=checkbox]").uncheck();
  await waitFor(async () => !(await e.host.library()).songs[0].enabled);
  await page.locator("#music-viewerSongs").selectOption("approval");
  await waitFor(async () => (await e.host.library()).viewerSongs === "approval");
  assert.equal(
    (await e.host.viewerSave({ type: "rave-remember", value: "Viewer artist - Viewer song" }))
      .pending,
    true,
  );
  await page.locator("#music-pendingList").getByRole("button", { name: "Approve" }).click();
  await page.locator("#music-songList strong", { hasText: "Viewer song" }).waitFor();
  await page.locator("#music-songSearch").fill("edited");
  assert.equal(await page.locator("#music-songList .musicLibraryRow").count(), 1);
  await page.locator("#music-songList").getByRole("button", { name: "Remove" }).click();
  await page.locator("#music-songSearch").fill("");
  await page.locator("#music-songList strong", { hasText: "Viewer song" }).waitFor();
  await page.screenshot({
    path: path.resolve(__dirname, "../runtime/music-song-library.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator("#music-preview").click();
  await waitFor(() => e.captures === 1);
  await e.pump();
  const drawnColors = e.host.pipeline().effective.palette;
  assert(drawnColors.length >= 3 && drawnColors.length <= 7);
  assert.equal(e.host.pipeline().recipe.color, "energy");
  assert.equal(e.host.pipeline().effective.warmCoolColors, true);
  await page.waitForFunction(
    () => document.getElementById("music-randomPalette").children.length >= 3,
  );
  assert.equal(await page.locator("#music-randomPalette span").count(), drawnColors.length);
  await page.locator("#music-bookmark").click();
  await waitFor(() => e.host.effects().profiles.length === 1);
  assert.deepEqual(e.host.effects().profiles[0].artistic.palette, drawnColors);
  await page.locator("#music-stop").click();
  await choose("paletteSource", "custom");
  await waitFor(() => e.host.view().design.recipeOptions.palette.mode === "configured");
  assert.deepEqual(e.host.view().design.palette, customColors);
  await page.getByRole("button", { name: "Automation", exact: true }).click();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.locator(".musicSavedManage > summary").click();
  await page.locator("#music-renameEffectName").fill("Kept from Main");
  await page.locator("#music-renameEffect").click();
  await waitFor(() => e.host.effects().profiles[0].name === "Kept from Main");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.screenshot({
    path: path.resolve(__dirname, "../runtime/music-main-dashboard-mobile.png"),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
});

test("profile creator keeps custom colors, shuffles independently and exposes only applicable tuning", async (t) => {
  const { chromium } = require("playwright");
  const e = await environment(t),
    browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(e.base + "/");
  await page.locator('[data-tab="lights"]').click();
  await page.locator('[data-light-tab="music"]').click();
  await page.waitForFunction(() => !document.getElementById("music-look").disabled);
  assert.equal(await page.locator('[data-look][data-kind="profile"]').count(), 10);
  assert.equal(await page.locator("#music-responseAdjustments").isVisible(), false);
  const custom = e.host.view().design.palette;
  await page.locator('[data-look="beat-relay"]').click();
  await waitFor(() => e.host.view().design.behaviors.profileMotion === 2);
  assert.equal(e.host.view().design.behaviors.profilePaletteEnabled, true);
  assert.deepEqual(e.host.view().design.palette, custom);
  await page.locator('#music-paletteSource + div button[data-value="custom"]').click();
  await waitFor(() => !e.host.view().design.behaviors.profilePaletteEnabled);
  assert.equal(await page.locator("#music-palette").isVisible(), true);
  await page.locator('#music-paletteSource + div button[data-value="generated"]').click();
  await waitFor(() => e.host.view().design.recipeOptions.palette?.allowed[0] === "generated");
  await page.locator("#music-behavior-randomProfileEnabled").check();
  await waitFor(() => e.host.view().design.behaviors.randomProfileEnabled);
  await page.locator('[data-look="spectrum-room"]').click();
  await waitFor(() => e.host.view().design.behaviors.profileMotion === 6);
  assert.equal(e.host.view().design.recipeOptions.palette.allowed[0], "generated");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  assert.equal(await page.locator("#music-behavior-profileBeats").isDisabled(), true);
  assert.equal(await page.locator("#music-behavior-profileDepth").isDisabled(), false);
  await page.locator("#music-behavior-profileMotion").selectOption("4");
  await waitFor(() => e.host.view().design.behaviors.profileMotion === 4);
  await page.waitForFunction(
    () => !document.getElementById("music-behavior-profileBeats").disabled,
  );
  await page.locator("#music-behavior-profileBeats").selectOption("8");
  await page.locator("#music-applyProfile").click();
  await waitFor(() => e.host.view().design.behaviors.profileBeats === 8);
  assert.equal(e.host.view().design.behaviors.literalAttackMs, 35);
  assert.equal(e.host.view().design.behaviors.literalReleaseMs, 100);
  await page.waitForFunction(() => !document.getElementById("music-look").disabled);
  assert.notEqual(await page.locator("#music-notice").getAttribute("data-error"), "true");
  await page.screenshot({
    path: path.resolve(__dirname, "../runtime/music-profile-creator.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.screenshot({
    path: path.resolve(__dirname, "../runtime/music-profiles-play.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  for (const name of ["Play", "Create"]) {
    await page.getByRole("button", { name, exact: true }).click();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
  }
  assert.equal(e.captures, 0, "profile selection cannot start capture or grant output");
  assert.deepEqual(errors, []);
});

test("preview uses the selected room and saved fixture palettes replay on its real routes", async (t) => {
  const e = await environment(t);
  await e.select(true);
  await e.call("music.styles.v1", "configure", {
    ...e.host.view().design,
    behaviors: { ...e.host.view().design.behaviors, profileMotion: 2, profilePaletteEnabled: true },
    recipeOptions: {
      paletteScope: { mode: "fixed", value: "fixtures", allowed: ["fixtures"] },
      palette: { mode: "random", value: "generated", allowed: ["generated"] },
    },
  });
  await e.call("music.session.v1", "start", { mode: "preview" });
  await e.pump();
  assert.equal(e.host.pipeline().assignments.length, 1);
  assert.equal(e.host.pipeline().assignments[0].id, "music-bulb");
  const saved = await e.host.saveEffect({ name: "Room preview" });
  assert.equal(saved.assignments[0].id, "music-bulb");
  assert(saved.assignments[0].assignedPalette.length >= 3);
  await e.call("music.session.v1", "stop");
  await e.host.effectPolicy({ mode: "single", ids: [saved.id] });
  await e.call("music.session.v1", "start", { mode: "live" });
  await e.pump();
  assert.deepEqual(
    e.host.pipeline().assignments[0].assignedPalette,
    saved.assignments[0].assignedPalette,
  );
});

test("Entertainment Stop and later status calls remain valid through native HTTP contracts", async (t) => {
  const e = await environment(t, undefined, undefined, true);
  await e.select(true);
  await e.call("music.styles.v1", "configure", { ...e.host.view().design, outputHz: 16 });
  await e.call("music.session.v1", "start", { mode: "live", seconds: 2 });
  await e.pump();
  assert.equal((await e.call("music.session.v1", "status")).session.state, "running");
  const response = await e.http("/api/music-to-light/call", "POST", {
    capability: "music.session.v1",
    method: "stop",
    payload: null,
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.ok, true);
  assert.equal(result.value.session.state, "stopped");
  const status = await e.call("music.session.v1", "status");
  assert.equal(status.state, "idle");
  assert.equal(status.session.ownedFixtures, 0);
  assert.deepEqual(e.native, e.baseline);
});

test("Entertainment preheating status is readable before any command exists", async (t) => {
  let prepared;
  const barrier = new Promise((resolve) => {
    prepared = resolve;
  });
  const e = await environment(t, undefined, undefined, () => barrier);
  await e.select(true);
  await e.call("music.session.v1", "start", { mode: "live", seconds: 2 });
  await e.pump();
  const status = await e.call("music.session.v1", "status");
  assert.equal(status.state, "preheating");
  assert.equal(status.session.state, "preheating");
  assert.equal(status.session.ownedFixtures, 0);
  assert.equal(status.session.frames, 0);
  prepared({ ok: true, activeIds: ["music-bulb"] });
  await flush();
  await e.call("music.session.v1", "stop");
  assert.equal((await e.call("music.session.v1", "status")).state, "idle");
});

test("contrast HTTP edits are local, persist in bindings and do not interrupt live or preview", async (t) => {
  const e = await environment(t);
  await e.select(true);
  const edit = (percent, fixtures = null, origin) =>
    e.http("/api/music-to-light/contrast", "PUT", { value: { percent, fixtures } }, origin);
  assert.equal((await edit(40)).status, 200);
  assert.equal(e.host.view().bindings.fixtures[0].outOfSync, 40);
  assert.equal(e.captures, 0);
  assert.equal((await edit(90, null, "https://untrusted.example")).status, 403);
  assert.equal((await edit(90, ["missing"])).status, 400);
  await e.call("music.session.v1", "start", { mode: "live" });
  await e.pump();
  assert.equal((await edit(85, ["music-bulb"])).status, 200);
  assert.equal(e.host.pipeline().assignments[0].outOfSync, 85);
  await e.pump();
  assert.equal(e.captures, 1);
  assert.equal(e.stops, 0);
  await e.call("music.session.v1", "stop");
  assert.deepEqual(e.native, e.baseline);
  await e.call("music.session.v1", "start", { mode: "preview" });
  await e.pump();
  assert(e.host.pipeline().assignments.every((f) => f.outOfSync === 85));
  assert.equal((await edit(25)).status, 200);
  assert(e.host.pipeline().assignments.every((f) => f.outOfSync === 25));
});

test("contrast survives private operator persistence without entering the portable design", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-contrast-"));
  t.after(() => {
    const relative = path.relative(os.tmpdir(), root);
    assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const broker = createBroker({
    isEligible: () => true,
    readState: async () => ({ ok: true, state: { on: false, bri: 100 } }),
    writeState: async () => ({ sent: 1, failed: 0 }),
    restoreState: async () => ({ sent: 1, failed: 0 }),
  });
  t.after(() => broker.shutdown());
  const options = {
    operatorPath: path.join(root, "operator.json"),
    core: {
      fixtureOutput: { ownership: broker },
      fixtureRegistry: {
        getFixtures: () => [
          { id: "one", brand: "hue", enabled: true },
          { id: "two", brand: "wiz", enabled: true },
        ],
      },
    },
  };
  const first = createHost(options);
  await first.fixtures([
    { id: "one", role: "all", position: 0 },
    { id: "two", role: "all", position: 1 },
  ]);
  await first.contrast({ percent: 80, fixtures: ["two"] });
  await first.shutdown();
  const second = createHost(options);
  t.after(() => second.shutdown());
  assert.equal(second.view().operatorRecovered, false);
  assert.equal(second.view().bindings.fixtures.find((f) => f.id === "two").outOfSync, 80);
  assert.equal(second.view().bindings.fixtures.find((f) => f.id === "one").outOfSync, undefined);
  assert.equal(second.view().design.outOfSync, undefined);
});

test("warm/cool toggles live inside a locked random recipe without capture restart or palette redraw", async (t) => {
  const e = await environment(t);
  await e.select(true);
  await e.call("music.styles.v1", "configure", {
    ...e.host.view().design,
    recipeOptions: { palette: { mode: "random", value: "generated", allowed: ["generated"] } },
  });
  await e.call("music.session.v1", "start", { mode: "live" });
  await e.pump();
  const before = e.host.pipeline();
  for (const warmCoolColors of [true, false, true]) {
    await e.call("music.styles.v1", "configure", { ...e.host.view().design, warmCoolColors });
    await e.pump();
    const after = e.host.pipeline();
    assert.equal(after.effective.warmCoolColors, warmCoolColors);
    assert.deepEqual(after.effective.palette, before.effective.palette);
    assert.equal(after.recipeId, before.recipeId);
    assert.equal(e.captures, 1);
    assert.equal(e.stops, 0);
    assert.equal(e.host.view().status.session.ownedFixtures, 1);
  }
  await e.call("music.session.v1", "stop");
  assert.deepEqual(e.native, e.baseline);
});

test("legacy pulse settings cannot return through a locked native recipe", async (t) => {
  const e = await environment(t);
  await e.select(true);
  await e.call("music.styles.v1", "configure", {
    ...e.host.view().design,
    interpretation: "musical",
    intensity: 1,
    maximumBrightness: 100,
    recipeOptions: { palette: { mode: "random", value: "generated", allowed: ["generated"] } },
    behaviors: {
      ...e.host.view().design.behaviors,
      attacksEnabled: true,
      steadyBrightness: true,
      loudnessBrightness: true,
    },
  });
  assert.equal(e.host.view().design.interpretation, "literal");
  assert.equal(e.host.view().design.behaviors.attacksEnabled, false);
  await e.call("music.session.v1", "start", { mode: "live" });
  await e.pump();
  const before = e.host.pipeline();
  await e.call("music.styles.v1", "configure", {
    ...e.host.view().design,
    behaviors: {
      ...e.host.view().design.behaviors,
      literalAttackMs: 80,
      literalReleaseMs: 160,
      attacksEnabled: true,
      steadyBrightness: true,
    },
  });
  await e.pump();
  const after = e.host.pipeline();
  assert.equal(after.effective.behaviors.steadyBrightness, false);
  assert.equal(after.effective.behaviors.attacksEnabled, false);
  assert.equal(after.effective.behaviors.literalAttackMs, 80);
  assert.equal(after.effective.behaviors.literalReleaseMs, 160);
  assert.equal(after.recipeId, before.recipeId);
  assert.deepEqual(after.effective.palette, before.effective.palette);
  assert.equal(e.captures, 1);
  assert.equal(e.stops, 0);
});
