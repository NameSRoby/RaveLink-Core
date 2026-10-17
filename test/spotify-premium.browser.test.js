const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { chromium } = require("playwright");
const createCore = require("../src/app/core/create-core-server"),
  extension = require("../src/app/optional/create-feature-platform-extension");
test(
  "one Spotify UI optionally connects Premium, chooses a device, queues songs, controls volume and explains moderation limits",
  { timeout: 45000 },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "spotify-premium-ui-"));
    fs.cpSync(
      path.join(__dirname, "../features/song-request"),
      path.join(root, "installed/song-request"),
      { recursive: true },
    );
    const calls = [],
      queue = [],
      ID = "A".repeat(22);
    const track = (id) => ({
      uri: "spotify:track:" + id,
      id,
      type: "track",
      name: id === ID ? "Track" : "Personal song",
      artists: [{ name: "Artist" }],
      album: { name: "Album" },
      duration_ms: 240000,
      is_playable: true,
    });
    const json = (value) =>
      new Response(JSON.stringify(value), {
        headers: { "content-type": "application/json" },
      });
    const created = createCore({
      rootDir: path.join(__dirname, ".."),
      runtimeDir: path.join(root, "runtime"),
      dryRun: true,
      capabilities: { features: true },
      extend: extension({
        featuresRoot: path.join(root, "installed"),
        runtimeRoot: path.join(root, "features-runtime"),
        allowUnsafeRuntime: true,
        spotifyProtect: (values) => ({
          ok: true,
          encrypted: {
            fixture: Buffer.from(JSON.stringify(values)).toString("base64"),
          },
        }),
        spotifyUnprotect: (encrypted) => ({
          ok: true,
          plain: JSON.parse(Buffer.from(encrypted.fixture, "base64").toString()),
        }),
        spotifyOfficialFetch: async (url, init) => {
          const parsed = new URL(url);
          calls.push({
            path: parsed.pathname,
            method: init.method,
            query: parsed.searchParams,
          });
          if (parsed.hostname === "accounts.spotify.com") {
            assert.equal(parsed.pathname, "/api/token");
            assert.equal(init.body.has("client_secret"), false);
            return json({
              access_token: "fixture-access",
              refresh_token: "fixture-refresh",
              token_type: "Bearer",
              expires_in: 3600,
              scope: "user-read-private user-read-playback-state user-modify-playback-state",
            });
          }
          assert.equal(parsed.hostname, "api.spotify.com");
          if (parsed.pathname === "/v1/me") return json({ account_id: "fixture-account" });
          if (parsed.pathname === "/v1/me/player")
            return json({
              item: track("B".repeat(22)),
              is_playing: false,
              progress_ms: 12000,
              device: {
                id: "device-a",
                supports_volume: true,
                volume_percent: 40,
              },
            });
          if (parsed.pathname === "/v1/me/player/devices")
            return json({
              devices: [
                {
                  id: "device-a",
                  name: "Test laptop",
                  is_active: true,
                  is_restricted: false,
                },
              ],
            });
          if (parsed.pathname === "/v1/search") return json({ tracks: { items: [track(ID)] } });
          if (parsed.pathname === "/v1/me/player/queue" && init.method === "POST") {
            assert.equal(parsed.searchParams.get("device_id"), "device-a");
            queue.push(parsed.searchParams.get("uri"));
            return new Response(null, { status: 204 });
          }
          if (parsed.pathname === "/v1/me/player/queue")
            return json({ queue: queue.map((uri) => track(uri.slice(14))) });
          if (parsed.pathname === "/v1/me/player/volume")
            return new Response(null, { status: 204 });
          throw Error("Unexpected endpoint " + parsed.pathname);
        },
      }),
    });
    await created.extension.startup;
    await created.extension.registry.request(
      "song-request",
      "song.player.preferences.v1",
      "select",
      { player: "spotify" },
    );
    const server = await new Promise((resolve) => {
        const s = created.app.listen(0, "127.0.0.1", () => resolve(s));
      }),
      browser = await chromium.launch({ headless: true });
    t.after(async () => {
      await browser.close();
      await created.extension.shutdown();
      await created.services.lifecycle.stopAll();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(root, { recursive: true, force: true });
    });
    const context = await browser.newContext({
        viewport: { width: 1280, height: 960 },
      }),
      page = await context.newPage(),
      errors = [],
      base = "http://127.0.0.1:" + server.address().port;
    page.on("pageerror", (error) => errors.push(error.message));
    await context.route("https://accounts.spotify.com/authorize?**", async (route) => {
      const url = new URL(route.request().url());
      assert.equal(url.searchParams.get("scope").includes("playlist"), false);
      const callback = new URL(url.searchParams.get("redirect_uri"));
      callback.searchParams.set("code", "fixture-code");
      callback.searchParams.set("state", url.searchParams.get("state"));
      await route.fulfill({
        status: 302,
        headers: { location: callback.href },
        body: "",
      });
    });
    await page.goto(base + "/features-ui/song-request/player");
    const surface = page.locator("#surface").contentFrame();
    await surface.locator("#spotifyConnection").waitFor();
    assert.equal(calls.length, 0, "Free companion does not contact the official API");
    await surface.locator("#spotifyOpenSetup").click();
    await surface.getByText("Optional Spotify Premium connection", { exact: true }).click();
    await surface.locator("#spotifyClientId").fill("a".repeat(32));
    await surface.locator("#spotifySaveClient").click();
    await surface.locator("#spotifySignIn:not([disabled])").waitFor();
    assert.equal(await surface.locator("#spotifyClientId").inputValue(), "");
    const popupPromise = context.waitForEvent("page");
    await surface.locator("#spotifySignIn").click();
    const popup = await popupPromise;
    await popup.waitForURL(base + "/auth/spotify/result?result=connected");
    await popup.close();
    await surface.locator("#spotifyAccountCheck").click();
    await surface
      .locator("#spotifyAccountStatus")
      .filter({ hasText: "Account connected" })
      .waitFor();
    await surface.locator("#spotifyDevices").click();
    await surface
      .locator("#spotifyDeviceChoices")
      .getByRole("button", { name: "Test laptop · active" })
      .click();
    await surface
      .locator("#spotifyDeviceStatus")
      .filter({ hasText: "Official controls are available" })
      .waitFor();
    await surface.locator("#playerTab-player").click();
    await surface.locator("#videoInput").fill("Artist Track");
    await surface.locator("#addSong").click();
    await surface.locator("#queue").getByText("Queued in Spotify").waitFor();
    assert.equal(queue.length, 1);
    assert.equal(
      await surface
        .locator("#queue")
        .getByRole("button", { name: "REMOVE", exact: true })
        .isDisabled(),
      true,
    );
    assert.equal(await surface.locator("#spotifyOfficialLimit").isVisible(), true);
    await surface.locator("#volume:not([disabled])").waitFor();
    await surface.locator("#volume").fill("50");
    await surface.locator("#volume").dispatchEvent("change");
    await surface.locator("#volumeNotice").filter({ hasText: "Volume saved" }).waitFor();
    assert.equal(
      calls.find((row) => row.path.endsWith("/volume")).query.get("volume_percent"),
      "20",
    );
    await surface.locator("#queue").getByRole("button", { name: "BAN SONG", exact: true }).click();
    await surface.locator("#notice").filter({ hasText: "Spotify" }).waitFor();
    assert.equal(
      queue.length,
      1,
      "official-only moderation cannot falsely remove the native queue item",
    );
    assert.equal(
      calls.filter((row) => row.path.endsWith("/queue") && row.method === "POST").length,
      1,
    );
    assert.deepEqual(errors, []);
    await page.setViewportSize({ width: 430, height: 930 });
    assert.equal(
      await surface
        .locator("body")
        .evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      true,
    );
    await page.screenshot({
      path: path.join(__dirname, "../runtime/spotify-premium-ui.png"),
      fullPage: true,
    });
  },
);
