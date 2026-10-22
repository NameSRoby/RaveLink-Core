const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const registerRewards = require("../src/capabilities/feature-platform/http/register-dashboard-rewards.routes");
const createCoreServer = require("../src/app/core/create-core-server");
async function listen(t, app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  return `http://127.0.0.1:${server.address().port}`;
}
test("dashboard reward controls admit only managed rewards, preserve closed intake and report partial failures", async (t) => {
  const app = express();
  app.use(express.json());
  let songPaused = true,
    connected = true,
    fail = false;
  const writes = [],
    managed = [
      { rewardId: "a", purpose: "lights" },
      { rewardId: "b", purpose: "song_request" },
    ];
  const rows = [
    { id: "a", title: "Lights", cost: 100, manageable: true, enabled: true, paused: false },
    { id: "b", title: "Songs", cost: 200, manageable: true, enabled: true, paused: true },
    { id: "foreign", title: "External", cost: 20, manageable: true, paused: false },
  ];
  const provider = {
    status: () => ({ connected, managedRewards: managed }),
    listRewards: async () => ({ ok: true, rewards: rows }),
    async setManagedRewardPaused(input) {
      writes.push(input);
      if (fail && input.purpose === "lights") return { ok: false, error: "private_error" };
      rows.find((r) => managed.find((m) => m.rewardId === r.id)?.purpose === input.purpose).paused =
        input.paused;
      return { ok: true };
    },
  };
  registerRewards(app, {
    getProvider: () => provider,
    registry: {
      list: () => ({
        features: [
          { id: "twitch-integration", lifecycle: "active" },
          { id: "song-request", lifecycle: "active" },
        ],
      }),
      request: async () => ({ ok: true, value: { paused: songPaused } }),
    },
  });
  const base = await listen(t, app);
  const send = (body, origin) =>
    fetch(base + "/api/dashboard/rewards", {
      method: "POST",
      headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
      body: JSON.stringify(body),
    });
  const initial = await fetch(base + "/api/dashboard/rewards").then((r) => r.json());
  assert.deepEqual(
    initial.rewards.map((r) => r.purpose),
    ["lights", "song_request"],
  );
  assert.equal(writes.length, 0);
  assert.equal(
    (await send({ purpose: "all", paused: true }, "https://foreign.invalid")).status,
    403,
  );
  assert.equal((await send({ purpose: "all", paused: "true" })).status, 400);
  assert.equal((await send({ purpose: "all", paused: true, rewardId: "foreign" })).status, 400);
  const paused = await send({ purpose: "all", paused: true }).then((r) => r.json());
  assert.equal(paused.partial, false);
  assert(paused.state.rewards.every((r) => r.paused));
  const held = await send({ purpose: "all", paused: false }).then((r) => r.json());
  assert.equal(held.partial, true);
  assert(held.results.some((r) => r.held));
  assert.equal(rows[1].paused, true);
  songPaused = false;
  fail = true;
  const partial = await send({ purpose: "all", paused: false }).then((r) => r.json());
  assert.equal(partial.partial, true);
  assert.equal(rows[1].paused, false);
  assert.equal(JSON.stringify(partial).includes("private_error"), false);
  assert(writes.every((w) => ["lights", "song_request"].includes(w.purpose)));
  connected = false;
  const before = writes.length;
  assert.equal((await send({ purpose: "all", paused: true })).status, 409);
  assert.equal(writes.length, before);
});
test("Core-only dashboard works with empty private state and rejects foreign readers", async (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-dashboard-"));
  const created = createCoreServer({ runtimeDir, dryRun: true });
  t.after(async () => {
    await created.services.lifecycle.stopAll();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });
  const base = await listen(t, created.app);
  const response = await fetch(base + "/api/dashboard");
  const state = await response.json();
  assert.equal(response.status, 200);
  assert.equal(state.featuresAvailable, false);
  assert.equal(state.song, null);
  assert.deepEqual(state.packages, []);
  assert.equal(state.music.ready, false);
  assert.equal(state.music.autoRave, false);
  assert.equal((await fetch(base + "/api/dashboard", { headers: { origin: "null" } })).status, 403);
  const settings = await fetch(base + "/api/presentation/dashboard").then((r) => r.json());
  assert.equal(settings.catalog.length, 6);
  const layout = {
    widgets: ["music", "song", "shortcuts"],
    hiddenActions: ["music-rave"],
    density: "compact",
    columns: "one",
  };
  const put = (value, origin) =>
    fetch(base + "/api/presentation/dashboard", {
      method: "PUT",
      headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
      body: JSON.stringify({ layout: value }),
    });
  assert.equal((await put(layout, "https://untrusted.invalid")).status, 403);
  assert.equal((await put({ ...layout, widgets: ["arbitrary-widget"] })).status, 400);
  assert.equal((await put({ ...layout, hiddenActions: ["raw-html"] })).status, 400);
  assert.equal((await put(layout)).status, 200);
  const fresh = express();
  fresh.use(express.json());
  require("../src/app/core/register-dashboard-layout.routes")(fresh, { runtimeDir });
  const freshBase = await listen(t, fresh);
  assert.deepEqual(
    (await fetch(freshBase + "/api/presentation/dashboard").then((r) => r.json())).layout,
    layout,
  );
});
test("dashboard quick actions remain usable on desktop and phone without running real rewards or lights", async (t) => {
  const { chromium } = require("playwright");
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-dashboard-browser-"));
  const created = createCoreServer({ runtimeDir, dryRun: true });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await created.services.lifecycle.stopAll();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });
  const base = await listen(t, created.app);
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const errors = [],
    calls = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const state = {
    ok: true,
    packages: [
      {
        id: "song-request",
        name: "Song Request",
        lifecycle: "active",
        pages: [{ id: "player", title: "Player" }],
      },
      {
        id: "twitch-integration",
        name: "Twitch Integration",
        lifecycle: "active",
        pages: [{ id: "connection", title: "Connection" }],
      },
    ],
    featuresAvailable: true,
    song: {
      paused: false,
      queued: 4,
      title: "A synthetic test song",
      canSkip: true,
      entryId: "current-entry",
    },
    twitchActive: true,
    music: {
      state: "idle",
      source: "Test player",
      lights: 4,
      ready: true,
      autoRave: false,
      pending: 2,
    },
    profiles: [{ id: "studio", name: "Studio" }],
  };
  const rewards = {
    ok: true,
    available: true,
    rewards: [
      {
        purpose: "lights",
        title: "Change my lights",
        cost: 100,
        paused: false,
        enabled: true,
        manageable: true,
      },
    ],
  };
  await page.route("**/api/dashboard", (route) => route.fulfill({ json: state }));
  await page.route("**/api/dashboard/rewards", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      calls.push(body);
      rewards.rewards[0].paused = body.paused;
      return route.fulfill({
        json: {
          ok: true,
          partial: false,
          state: rewards,
          results: [{ ok: true, purpose: "lights" }],
        },
      });
    }
    return route.fulfill({ json: rewards });
  });
  for (const pattern of [
    "**/api/features/song-request/call",
    "**/api/music-to-light/call",
    "**/api/music-to-light/songs/policy",
    "**/lighting-profiles/studio/apply",
  ])
    await page.route(pattern, async (route) => {
      const body = route.request().postDataJSON();
      calls.push({ url: new URL(route.request().url()).pathname, ...body });
      if (body.payload?.action === "pause") state.song.paused = true;
      if (body.payload?.action === "resume") state.song.paused = false;
      if (body.enabled !== undefined) state.music.autoRave = body.enabled;
      return route.fulfill({ json: { ok: true, value: { ok: true } } });
    });
  await page.goto(base, { waitUntil: "networkidle" });
  assert.equal(await page.locator('[data-panel="dashboard"]').isVisible(), true);
  await page.locator("#dashboardNowPlaying").filter({ hasText: "synthetic" }).waitFor();
  assert.equal(calls.length, 0, "viewing the dashboard never changes live state");
  await page.locator("#dashboardPauseRewards").click();
  await page.locator("#dashboardResumeRewards").waitFor({ state: "visible" });
  await page.waitForFunction(() => !document.getElementById("dashboardResumeRewards").disabled);
  await page.locator("#dashboardResumeRewards").click();
  await page.locator("#dashboardIntake").click();
  await page.locator("#dashboardIntake").filter({ hasText: "Resume requests" }).waitFor();
  await page.locator("#dashboardSkip").click();
  await page.locator("#dashboardSongNotice").filter({ hasText: "skipped" }).waitFor();
  assert(calls.some((c) => c.payload?.action === "skip" && c.payload.entryId === "current-entry"));
  await page.locator("#dashboardAutoRave").check();
  await page.locator("#dashboardMusicNotice").filter({ hasText: "saved" }).waitFor();
  assert(calls.some((c) => c.purpose === "all" && c.paused === true));
  assert(calls.some((c) => c.capability === "song.queue.admin.v1" && c.payload.action === "pause"));
  assert(calls.some((c) => c.enabled === true));
  const beforeEdit = calls.length;
  await page.locator("#themeButton").click();
  await page.locator("#dashboardEditToggle").click();
  await page.locator("#dashboardMusicStart").click();
  assert.equal(calls.length, beforeEdit);
  await page.locator("#dashboardAdd").click();
  await page.locator('[data-action="music-rave"]').uncheck();
  await page.locator('[data-widget="packages"]').uncheck();
  await page.locator('[data-widget="shortcuts"]').check();
  await page.locator("#dashboardDensity").selectOption("compact");
  await page.locator("#dashboardCatalogDone").click();
  await page.getByRole("button", { name: "Move up: Music-to-Light", exact: true }).click();
  assert.equal(await page.locator("#dashboardRave").isVisible(), false);
  assert.equal(await page.locator('[data-dashboard-widget="packages"]').isVisible(), false);
  assert.equal(await page.locator('[data-dashboard-widget="shortcuts"]').isVisible(), true);
  await page.locator("#dashboardEdit").click();
  await page.locator("#dashboardEditNotice").filter({ hasText: "layout saved" }).waitFor();
  assert.equal(calls.length, beforeEdit, "layout editing never invokes live controls");
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(
    await page.locator('[data-panel="dashboard"]').getAttribute("data-density"),
    "compact",
  );
  assert.equal(await page.locator("#dashboardRave").isVisible(), false);
  assert.equal(await page.locator('[data-dashboard-widget="packages"]').isVisible(), false);
  const order = await page
    .locator(".dashboardGrid > section:visible")
    .evaluateAll((nodes) => nodes.map((n) => n.dataset.dashboardWidget));
  assert(order.indexOf("music") < order.indexOf("song"));
  await page.screenshot({ path: path.resolve("runtime/dashboard-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.resolve("runtime/dashboard-mobile.png"), fullPage: true });
  assert.deepEqual(errors, []);
});
