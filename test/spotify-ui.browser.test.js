const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const { chromium } = require("playwright");
const createCoreServer = require("../src/app/core/create-core-server");
const createExtension = require("../src/app/optional/create-feature-platform-extension");

test("Spotify UI restores selection, separates setup, submits songs and keeps compact song/user moderation available", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-spotify-ui-"));
  fs.cpSync(
    path.join(__dirname, "../features/song-request"),
    path.join(root, "installed/song-request"),
    { recursive: true },
  );
  const actions = [];
  let connected = true;
  const status = () => ({
    ok: true,
    enabled: true,
    ready: connected,
    connected,
    controlsAvailable: connected,
    localDevice: connected,
    capacity: { limit: 10, queued: 10, available: 0, reported: true },
    handoffs: [],
    current: null,
    installation: { prepared: true },
  });
  const created = createCoreServer({
    rootDir: path.join(__dirname, ".."),
    runtimeDir: path.join(root, "runtime"),
    dryRun: true,
    capabilities: { features: true },
    extend: createExtension({
      featuresRoot: path.join(root, "installed"),
      runtimeRoot: path.join(root, "feature-runtime"),
      allowUnsafeRuntime: true,
      providers: {
        "spotify.desktop.host.v1/status": status,
        "spotify.desktop.host.v1/setup": (payload) => {
          actions.push(payload.action);
          connected = payload.action === "launch";
          return { ok: true };
        },
        "spotify.desktop.host.v1/resolve": () => ({
          ok: true,
          candidate: {
            provider: "spotify",
            providerItemId: "AAAAAAAAAAAAAAAAAAAAAA",
            title: "One More Time",
            artists: ["Daft Punk"],
            durationMs: 300000,
          },
        }),
        "spotify.desktop.host.v1/remove": () => ({ ok: true, removed: 0 }),
        "spotify.desktop.host.v1/control": (payload) => {
          actions.push(payload.action);
          return { ok: true, accepted: true };
        },
      },
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
  const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    }),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://www.youtube.com/**", (route) => route.abort());
  const base = "http://127.0.0.1:" + server.address().port;
  await page.goto(base + "/features-ui/song-request/player");
  const surface = page.locator("#surface").contentFrame();
  const picker = surface.locator("#songPlayerProvider");
  await surface.locator("#songPlayerProvider:not([disabled])").waitFor({ state: "attached" });
  await surface
    .locator('[data-choice-for="songPlayerProvider"] [data-choice-value="spotify"]')
    .click();
  await surface.locator("#spotifyConnection").filter({ hasText: "Connected" }).waitFor();
  assert.equal(await surface.locator("#tidalPlayback").isVisible(), false);
  assert.equal(await surface.locator("#spotifySetup").isVisible(), false);
  assert.equal(await surface.locator("#spotifyPlaybackLaunch").isVisible(), false);
  const knownIssues = surface.locator("#providerKnownIssues");
  assert.equal(await knownIssues.isVisible(), true);
  assert.equal(await knownIssues.getAttribute("open"), null);
  assert.doesNotMatch(await surface.locator(".playerProviderPicker").innerText(), /Alpha/);
  await knownIssues.locator("summary").click();
  assert.match(await knownIssues.innerText(), /Free-account ads/);
  assert.match(
    await knownIssues.locator("a").getAttribute("href"),
    /issues\/new\?template=bug_report.yml$/,
  );
  connected = false;
  await surface.locator("#spotifyPlaybackLaunch").waitFor();
  await surface.locator("#spotifyPlaybackLaunch").click();
  await surface.locator("#spotifyPlaybackLaunch").waitFor({ state: "hidden" });
  assert.ok(actions.includes("launch"));
  await surface.locator("#spotifyOpenSetup").click();
  await surface.locator("#spotifyPrepare").click();
  assert.equal(await knownIssues.isVisible(), false);
  await page.waitForTimeout(100);
  assert.ok(actions.includes("prepare"));
  await surface.locator("#spotifyLaunch").click();
  await page.waitForTimeout(100);
  assert.ok(actions.includes("launch"));
  await surface.locator("#playerTab-player").click();
  await surface.locator("#videoInput").fill("Daft Punk One More Time");
  await surface.locator("#addSong").click();
  await surface.locator("#queue").getByText("One More Time", { exact: true }).waitFor();
  assert.match(await surface.locator("#queue").innerText(), /Local Spotify operator/);
  await surface
    .locator('[data-choice-for="songPlayerProvider"] [data-choice-value="youtube"]')
    .click();
  await surface
    .locator('[data-choice-for="songPlayerProvider"] [data-choice-value="youtube"]:not([disabled])')
    .waitFor();
  assert.equal(await knownIssues.isVisible(), false);
  await surface
    .locator("#queue")
    .getByText("One More Time", { exact: true })
    .waitFor({ state: "hidden" });
  await surface
    .locator('[data-choice-for="songPlayerProvider"] [data-choice-value="spotify"]')
    .click();
  await surface
    .locator('[data-choice-for="songPlayerProvider"] [data-choice-value="spotify"]:not([disabled])')
    .waitFor();
  await surface.locator("#queue").getByText("One More Time", { exact: true }).waitFor();
  assert.equal(await knownIssues.getAttribute("open"), null);
  assert.equal(
    await surface
      .locator("#queue")
      .getByRole("button", { name: "BAN SONG", exact: true })
      .isVisible(),
    true,
  );
  assert.equal(
    await surface
      .locator("#queue")
      .getByRole("button", { name: "TIMEOUT SONG", exact: true })
      .isVisible(),
    true,
  );
  await surface.locator("#queue").getByRole("button", { name: "REMOVE", exact: true }).click();
  await surface.locator("#queue").getByText("No Spotify requests").waitFor();
  await page.reload();
  await surface.locator("#spotifyConnection").filter({ hasText: "Connected" }).waitFor();
  assert.equal(await picker.inputValue(), "spotify");
  assert.deepEqual(errors, []);
});
