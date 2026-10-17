const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const createCoreServer = require("../src/app/core/create-core-server");
const createFeaturePlatformExtension = require("../src/app/optional/create-feature-platform-extension");

const VIDEO = Object.freeze({
  provider: "youtube",
  providerItemId: "dQw4w9WgXcQ",
  title: "Playback fixture",
  artists: ["RaveLink"],
  durationMs: 180000,
});

test("Player connects TIDAL automatically, signs in, chooses supported countries and keeps YouTube compact", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-player-tidal-"));
  const installer = require("../integrations/tidal-desktop/installer.cjs");
  const tidalResources = path.join(root, "TIDAL/app-2.43.2/resources");
  fs.mkdirSync(tidalResources, { recursive: true });
  const originalArchive = require("./support/tidal-asar-fixture.cjs")();
  fs.writeFileSync(path.join(tidalResources, "app.asar"), originalArchive);
  let tidalRunning = true,
    reportedVersion = "",
    heartbeat;
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
    extend: createFeaturePlatformExtension({
      featuresRoot: path.join(root, "installed"),
      runtimeRoot: path.join(root, "feature-runtime"),
      allowUnsafeRuntime: true,
      tidalCompanionInstaller: {
        discover: () => [tidalResources],
        inspect: (resources) => ({
          ...installer.inspect(resources),
          ...(reportedVersion ? { version: reportedVersion } : {}),
        }),
        install: (args) => {
          const result = installer.install({
            ...args,
            probe: () => tidalRunning,
          });
          reportedVersion = "";
          return result;
        },
        uninstall: (args) => installer.uninstall({ ...args, probe: () => tidalRunning }),
      },
      tidalCatalogFetch: require("./support/tidal-catalog-fixture.cjs"),
      providers: {
        "youtube.catalog.host.v1/status": () => ({
          ok: true,
          configured: true,
          mode: "keyless",
        }),
      },
    }),
  });
  await created.extension.startup;
  const server = await new Promise((resolve) => {
    const listener = created.app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    clearInterval(heartbeat);
    await browser.close();
    await created.extension.shutdown();
    await created.services.lifecycle.stopAll();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  await context.route("https://www.youtube.com/iframe_api", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `window.YT={PlayerState:{PLAYING:1,ENDED:0},Player:function(id,options){
    const frame=document.createElement('iframe');frame.id=id;frame.style.cssText='width:100%;height:100%';document.getElementById(id).replaceWith(frame);
    const api={setVolume(){},pauseVideo(){},stopVideo(){},playVideo(){},loadVideoById(){}};setTimeout(()=>options.events.onReady(),0);return api}};window.onYouTubeIframeAPIReady();`,
    }),
  );
  const page = await context.newPage(),
    base = `http://127.0.0.1:${server.address().port}`;
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base + "/features-ui/song-request/player");
  const surface = page.locator("#surface").contentFrame();
  await surface.locator('[data-choice-for="songPlayerProvider"]').waitFor();
  await surface.locator("iframe#playerFrame").waitFor();
  assert.equal(await surface.locator("#youtubeEmbedWarning").isVisible(), true);
  assert.match(await surface.locator("#youtubeEmbedWarning").innerText(), /crash/);
  await surface.locator("#playerFrame").evaluate((node) => {
    node.dataset.retained = "yes";
  });
  const videoBox = await surface.locator("#playerFrame").boundingBox();
  assert.ok(videoBox.width <= 561 && videoBox.height <= 316, JSON.stringify(videoBox));
  assert.equal(await surface.locator(".playerAdvancedPolicy").isHidden(), true);
  await page.screenshot({
    path: path.join(__dirname, "../runtime/player-youtube-compact.png"),
    fullPage: true,
  });
  await surface
    .locator('[data-choice-for="songPlayerProvider"] [data-choice-value="tidal"]')
    .click();
  await surface
    .locator('[data-choice-for="songPlayerProvider"] [data-choice-value="tidal"]:not([disabled])')
    .waitFor();
  await surface
    .locator('[data-choice-for="songPlayerProvider"] [data-choice-value="tidal"]:not([disabled])')
    .waitFor();
  assert.equal(await surface.locator("#youtubeEmbedWarning").isHidden(), true);
  assert.equal(await surface.locator("#tidalCatalogSetup").isHidden(), true);
  assert.equal(await surface.locator("#requesters").isHidden(), true);
  await surface.getByRole("tab", { name: "Setup", exact: true }).click();
  await surface.locator("#tidalConnection").filter({ hasText: "Finish the steps below" }).waitFor();
  assert.equal(await surface.locator("#playerFrame").isHidden(), true);
  assert.equal(await surface.locator(".queueSide").isHidden(), true);
  assert.equal(
    await surface.getByRole("tab", { name: "Setup", exact: true }).getAttribute("aria-selected"),
    "true",
  );
  assert.equal(await surface.locator("#playerFrame").getAttribute("data-retained"), "yes");
  assert.equal(await surface.locator("#enableTidal").count(), 0);
  assert.equal(await surface.locator("#songPlayerProvider option:checked").innerText(), "TIDAL");
  assert.equal(await surface.locator("#tidalDeveloperSettings").isHidden(), true);
  await surface
    .locator("#tidalApiState")
    .filter({ hasText: "Sign in for text searches" })
    .waitFor();
  assert.equal(await surface.locator("#tidalClientId").isVisible(), false);
  await page.screenshot({
    path: path.join(__dirname, "../runtime/player-tidal-setup.png"),
    fullPage: true,
  });
  assert.equal(await surface.locator("#playerFrame").isHidden(), true);
  assert.equal(await surface.locator("#catalogSettings").isHidden(), true);
  const wrongHost = await fetch(base + "/auth/tidal/callback", {
    headers: { host: "example.com" },
    redirect: "manual",
  });
  assert.equal(wrongHost.status, 403);
  const repeatedState = await fetch(base + "/auth/tidal/callback?state=one&state=two", {
    redirect: "manual",
  });
  assert.equal(repeatedState.status, 400);
  let oauthCallback;
  await context.route("https://login.tidal.com/authorize?**", async (route) => {
    const url = new URL(route.request().url());
    assert.equal(url.searchParams.get("client_id"), "sJO65HgFy1MmZi7i");
    assert.deepEqual(
      new Set(url.searchParams.get("scope").split(" ")),
      new Set([
        "search.read",
        "playlists.read",
        "playlists.write",
        "collection.read",
        "collection.write",
      ]),
    );
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.has("client_secret"), false);
    const callback = new URL(url.searchParams.get("redirect_uri"));
    assert.equal(callback.origin, base);
    callback.searchParams.set("state", url.searchParams.get("state"));
    callback.searchParams.set("code", "fixture-browser-code");
    oauthCallback = callback.href;
    await route.fulfill({
      status: 302,
      headers: { location: callback.href },
      body: "",
    });
  });
  assert.equal(await surface.locator("#tidalClientSecret").count(), 0);
  const popupPromise = context.waitForEvent("page");
  await surface.locator("#signInTidal").click();
  const popup = await popupPromise;
  await popup.waitForURL(base + "/auth/tidal/result?result=connected");
  assert.ok(!(await popup.content()).includes("fixture-browser-code"));
  assert.equal(await popup.evaluate(() => window.opener), null);
  const replay = await fetch(oauthCallback, { redirect: "manual" });
  assert.equal(replay.status, 303);
  assert.equal(
    new URL(replay.headers.get("location"), base).href,
    base + "/auth/tidal/result?result=tidal_oauth_session_expired",
  );
  assert.equal(replay.headers.get("cache-control"), "no-store");
  assert.equal(replay.headers.get("referrer-policy"), "no-referrer");
  await surface
    .locator("#tidalApiState")
    .filter({ hasText: "TIDAL account connected" })
    .waitFor({ timeout: 8000 });
  assert.equal(await surface.locator("#tidalAccountOptions").isVisible(), true);
  assert.equal(await surface.locator("#tidalCountry").evaluate((node) => node.tagName), "SELECT");
  assert.equal(await surface.locator('#tidalCountry option[value="PT"]').innerText(), "Portugal");
  assert.equal(await surface.locator('#tidalCountry option[value="ZZ"]').count(), 0);
  await surface.locator("#tidalCountry").selectOption({ label: "Portugal" });
  await surface.locator("#saveTidalRegion").click();
  await surface.locator("#tidalCountry").evaluate((node) => {
    if (node.value !== "PT") throw new Error("Selected country not retained");
  });
  await surface.locator("#testTidalCatalog").click();
  await surface.locator("#tidalApiState").filter({ hasText: "TIDAL account connected" }).waitFor();
  const savedVault = fs.readFileSync(path.join(root, "runtime/tidal-catalog-vault.json"), "utf8");
  assert.ok(!savedVault.includes("fixture-refresh-token"));
  assert.ok(!savedVault.includes("fixture-access-token"));
  await popup.close();
  await surface.locator("#installTidalCompanion").click();
  await surface.locator("#notice").filter({ hasText: "Close TIDAL" }).waitFor();
  assert.deepEqual(fs.readFileSync(path.join(tidalResources, "app.asar")), originalArchive);
  tidalRunning = false;
  await surface.locator("#installTidalCompanion").click();
  await surface.locator("#tidalInstallStatus").filter({ hasText: "companion installed" }).waitFor();
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(tidalResources, "app/config.json"))).coreUrl,
    base,
  );
  reportedVersion = "0.1.2";
  await surface.locator("#refreshTidal").click();
  await surface.locator("#updateTidalCompanion").waitFor();
  await surface.locator("#updateTidalCompanion").click();
  await surface.locator("#tidalInstallStatus").filter({ hasText: "Companion installed" }).waitFor();
  assert.equal(installer.inspect(tidalResources).version, "0.1.7");
  assert.equal(await surface.locator("#tidalConnectionOptions").isVisible(), true);
  await surface.locator("#uninstallTidalCompanion").click();
  await surface.locator("#notice").filter({ hasText: "archive restored" }).waitFor();
  assert.deepEqual(fs.readFileSync(path.join(tidalResources, "app.asar")), originalArchive);
  const token = JSON.parse(
    fs.readFileSync(path.join(root, "runtime/experimental-tidal-pairing.json")),
  ).token;
  const post = (method, body) =>
    fetch(base + "/experimental/tidal/bridge/" + method, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + token,
      },
      body: JSON.stringify(body),
    }).then((response) => response.json());
  const report = {
    count: 0,
    currentUid: "fixture-current",
    currentTrackId: "789",
    uids: [],
  };
  const commandBacklog = [];
  const poll = async () => {
    const result = await post("next", {
      companionId: "browser-companion",
      ready: true,
      moderationReady: true,
      queue: report,
    });
    if (result.command) commandBacklog.push(result.command);
    return result;
  };
  // Match renderer-poll.js: the real companion reports every two seconds.
  // A 250 ms fixture adds an unrelated telemetry burst during rapid UI actions
  // and can trip the unchanged IPC safety ceiling on fast hosted runners.
  heartbeat = setInterval(() => void poll().catch(() => {}), 2000);
  await poll();
  await surface.locator("#refreshTidal").click();
  await surface.locator("#tidalConnection").filter({ hasText: "ready to queue songs" }).waitFor();
  await surface.getByRole("tab", { name: "Playback", exact: true }).click();
  await surface
    .locator("#tidalPlaybackStatus")
    .filter({ hasText: "ready to queue songs" })
    .waitFor();
  assert.equal(
    await surface
      .locator("#tidalNowControls")
      .getByRole("button", { name: "BAN CURRENT SONG", exact: true })
      .isEnabled(),
    true,
  );
  assert.equal(
    await surface
      .locator("#tidalNowControls")
      .getByRole("button", { name: "TIMEOUT REQUESTER", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(
    await surface
      .locator("#tidalNowControls")
      .getByRole("button", { name: "BAN REQUESTER", exact: true })
      .isDisabled(),
    true,
  );
  assert.equal(
    await surface
      .locator("#tidalNowControls")
      .getByRole("button", { name: "TIMEOUT SONG", exact: true })
      .isEnabled(),
    true,
  );
  assert.equal(await surface.locator("#tidalCatalogSetup").isHidden(), true);
  const respond = async (result) => {
    for (let count = 0; count < 250; count++) {
      await poll();
      const command = commandBacklog.shift();
      if (command) {
        assert.equal(
          command.kind,
          result.candidate
            ? "resolve"
            : result.appended
              ? "append"
              : result.removed
                ? "remove"
                : "append",
          JSON.stringify(command),
        );
        if (result.appended) {
          report.count++;
          report.uids.push(result.uid);
        }
        if (result.removed) {
          report.uids = report.uids.filter((uid) => !result.uids.includes(uid));
          report.count = report.uids.length;
          if (result.uids.includes(report.currentUid)) {
            report.currentUid += "-next";
            report.currentTrackId = String(Number(report.currentTrackId) + 1);
            report.uids.shift();
            report.count = report.uids.length;
          }
        }
        const reply = await post("result", {
          id: command.id,
          companionId: "browser-companion",
          ok: true,
          ...result,
        });
        if (result.removed) await poll();
        return reply;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(
      "No TIDAL UI command: " +
        (await surface.locator("#requestNotice").innerText()) +
        "; notice: " +
        (await surface.locator("#notice").innerText()) +
        "; rows: " +
        (await surface.locator("#queue").innerText()),
    );
  };
  await surface.locator("#videoInput").fill("Artist TIDAL UI fixture");
  await surface.locator("#addSong").click();
  await respond({
    candidate: {
      provider: "tidal",
      providerItemId: "123",
      title: "TIDAL UI fixture",
      artists: ["Artist"],
      durationMs: 180000,
    },
  });
  await respond({
    ok: false,
    error: "tidal_append_unconfirmed",
    writeAttempted: true,
  });
  await surface
    .locator("#queue")
    .getByRole("button", { name: "REVIEW DELIVERY", exact: true })
    .click();
  await surface.getByRole("button", { name: /Not in TIDAL.*allow retry/ }).click();
  await surface
    .locator("#queue")
    .getByRole("button", { name: "RETRY IN TIDAL", exact: true })
    .waitFor();
  assert.equal((await poll()).command, null);
  await surface
    .locator("#queue")
    .getByRole("button", { name: "RETRY IN TIDAL", exact: true })
    .click();
  await respond({ appended: true, uid: "native-ui-uid" });
  await surface.locator("#queue").filter({ hasText: "Queued in TIDAL" }).waitFor();
  const nativeRow = surface.locator("#queue tr").filter({ hasText: "TIDAL UI fixture" });
  assert.equal(
    await nativeRow.getByRole("button", { name: "REMOVE", exact: true }).isVisible(),
    true,
  );
  assert.equal(
    await nativeRow.getByRole("button", { name: "BAN SONG", exact: true }).isVisible(),
    true,
  );
  const alignment = await nativeRow.evaluate((row) =>
    [...row.cells].map((cell) => ({
      top: cell.getBoundingClientRect().top,
      height: cell.getBoundingClientRect().height,
      display: getComputedStyle(cell).display,
    })),
  );
  assert.ok(
    alignment.every(
      (cell) =>
        cell.display === "table-cell" &&
        Math.abs(cell.top - alignment[0].top) < 1 &&
        Math.abs(cell.height - alignment[0].height) < 1,
    ),
    JSON.stringify(alignment),
  );
  await surface.getByRole("tab", { name: "Setup", exact: true }).click();
  await page.evaluate(() =>
    document.querySelector("#surface").contentWindow.postMessage(
      {
        channel: "ravelink-feature-ui-v1",
        type: "presentation",
        developerMode: true,
      },
      location.origin,
    ),
  );
  await surface.locator("#tidalDeveloperSettings").waitFor();
  assert.equal(await surface.locator("#tidalClientId").inputValue(), "");
  assert.equal(await surface.locator("#tidalClientId").getAttribute("type"), "password");
  assert.ok(!(await surface.locator("body").innerText()).includes("sJO65HgFy1MmZi7i"));
  await page.evaluate(() =>
    document.querySelector("#surface").contentWindow.postMessage(
      {
        channel: "ravelink-feature-ui-v1",
        type: "presentation",
        developerMode: false,
      },
      location.origin,
    ),
  );
  await surface.locator("#tidalDeveloperSettings").waitFor({ state: "hidden" });
  assert.equal(await surface.locator("#tidalAccountOptions").isVisible(), true);
  await surface.getByRole("tab", { name: "Playback", exact: true }).click();

  await page.waitForFunction(() => {
    const frame = document.querySelector("#surface");
    return frame.clientHeight + 2 >= frame.contentDocument.body.scrollHeight;
  });
  await surface
    .locator("body")
    .evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  assert.equal(await surface.locator("body").evaluate(() => scrollY), 0);
  await page.screenshot({
    path: path.join(__dirname, "../runtime/player-tidal-inline.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => {
    const frame = document.querySelector("#surface");
    return frame.clientHeight + 2 >= frame.contentDocument.body.scrollHeight;
  });
  assert.equal(
    await surface.locator("body").evaluate((node) => node.scrollWidth <= window.innerWidth),
    true,
  );
  assert.equal(await surface.locator("#signInTidal").isHidden(), true);
  await page.screenshot({
    path: path.join(__dirname, "../runtime/player-tidal-mobile.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  report.count = 10;
  report.uids = ["native-ui-uid", ...Array.from({ length: 9 }, (_, i) => "manual-" + i)];
  await poll();
  const longTrack = {
    provider: "tidal",
    providerItemId: "456",
    title: "The Book Of Souls",
    artists: ["Iron Maiden"],
    durationMs: 627000,
  };
  await surface.locator("#videoInput").fill("iron maiden the book of souls");
  await surface.locator("#addSong").click();
  await surface
    .locator("#requestNotice")
    .filter({ hasText: "is 10:27; your limit is 10:00" })
    .waitFor();
  assert.equal(await surface.locator("#videoInput").inputValue(), "iron maiden the book of souls");
  await surface.getByRole("tab", { name: "Moderation", exact: true }).click();
  await surface.locator("#maxSongMinutes").waitFor();
  assert.equal(await surface.locator("#viewerLimit").isHidden(), true);
  assert.equal(await surface.locator("#volumeCeiling").isHidden(), true);
  assert.equal(await surface.locator("#responseToggles").isHidden(), true);
  assert.equal(await surface.locator("#songSearchFilters").isVisible(), true);
  assert.equal(await surface.locator("#minimumViews").isHidden(), true);
  assert.equal(await surface.locator("#minimumConfidence").isVisible(), true);
  await surface.locator("#maxSongMinutes").fill("15");
  await surface.locator("#savePolicy").click();
  await surface.locator("#notice").filter({ hasText: "Request policy saved" }).waitFor();
  await surface
    .locator("#maxSongMinutes")
    .filter({})
    .evaluate((node) => {
      if (node.value !== "15") throw new Error("Duration limit not saved");
    });
  await surface.getByRole("tab", { name: "Playback", exact: true }).click();
  await surface.locator("#videoInput").fill("iron maiden the book of souls");
  await surface.locator("#addSong").click();
  await respond({ candidate: longTrack });
  await surface.locator("#requestNotice").filter({ hasText: "Added The Book Of Souls" }).waitFor();
  await surface.locator("#queue").filter({ hasText: "The Book Of Souls" }).waitFor();
  const requester = surface.locator("#queue tr").filter({ hasText: "The Book Of Souls" });
  await requester
    .locator(".moderationGroup[data-target=requester]")
    .getByRole("combobox")
    .selectOption("1");
  report.currentUid = "native-ui-uid";
  report.currentTrackId = "123";
  report.uids = Array.from({ length: 10 }, (_, i) => "manual-" + i);
  report.count = 10;
  await poll();
  await surface
    .locator("#tidalNowControls .currentRequester")
    .filter({ hasText: "Local TIDAL operator" })
    .waitFor();
  await surface
    .locator("#tidalNowControls")
    .getByLabel("Timeout duration for current requester")
    .selectOption("1");
  await surface
    .locator("#tidalNowControls")
    .getByRole("button", { name: "TIMEOUT REQUESTER", exact: true })
    .click();
  await respond({ removed: true, uids: ["native-ui-uid"] });
  await surface.locator("#notice").filter({ hasText: "Requester timed out" }).waitFor();
  await requester.waitFor({ state: "detached" });
  await surface
    .locator("#queue tr")
    .filter({ hasText: "TIDAL UI fixture" })
    .waitFor({ state: "detached" });
  await surface.getByRole("tab", { name: "Moderation", exact: true }).click();
  const restriction = surface
    .locator("#restrictedRequesters tr")
    .filter({ hasText: "Local TIDAL operator" });
  await restriction.waitFor({ timeout: 5000 }).catch(async () => {
    throw new Error(
      "Restrictions: " +
        (await surface.locator("#restrictedRequesters").innerText()) +
        "; notice:" +
        (await surface.locator("#notice").innerText()) +
        "; errors:" +
        JSON.stringify(errors) +
        "; registry:" +
        JSON.stringify(
          created.extension.registry.list().features.map((row) => ({
            id: row.id,
            lifecycle: row.lifecycle,
            error: row.error,
          })),
        ),
    );
  });
  await restriction.getByRole("button", { name: "BAN", exact: true }).click();
  await surface
    .locator("#notice")
    .filter({ hasText: "updated" })
    .waitFor({ timeout: 5000 })
    .catch(async () => {
      throw new Error(
        "Moderation failed: " +
          (await surface.locator("#notice").innerText()) +
          "; " +
          (await surface.locator("#restrictedRequesters").innerText()),
      );
    });
  await restriction.getByRole("button", { name: "UNBAN", exact: true }).click();
  await restriction.getByRole("button", { name: "END TIMEOUT", exact: true }).click();
  await surface
    .locator("#restrictedRequesters")
    .filter({ hasText: "No bans or active timeouts" })
    .waitFor();
  // Let the fixture's ban/unban/end-timeout burst settle before another native
  // insertion. Keep the supervisor's 120 frames/second protection unchanged.
  await page.waitForTimeout(1000);
  await surface.getByRole("tab", { name: "Playback", exact: true }).click();
  await surface.locator("#videoInput").fill("Artist TIDAL UI fixture");
  await surface.locator("#addSong").click();
  await respond({
    candidate: {
      provider: "tidal",
      providerItemId: "123",
      title: "TIDAL UI fixture",
      artists: ["Artist"],
      durationMs: 180000,
    },
  });
  await respond({ appended: true, uid: "native-ban-uid" });
  await surface
    .locator("#queue tr")
    .filter({ hasText: "TIDAL UI fixture" })
    .getByText("Queued in TIDAL", { exact: true })
    .waitFor({ timeout: 5000 })
    .catch(async () => {
      throw new Error(
        "Queue after insertion: " +
          (await surface.locator("#queue").innerText()) +
          "; notice:" +
          (await surface.locator("#notice").innerText()) +
          "; connection:" +
          (await surface.locator("#tidalConnection").innerText()) +
          "; feature:" +
          JSON.stringify(
            created.extension.registry.list().features.map(({ lifecycle, error, runtime }) => ({
              lifecycle,
              error,
              runtime,
            })),
          ),
      );
    });
  await surface
    .locator("#queue tr")
    .filter({ hasText: "TIDAL UI fixture" })
    .getByRole("button", { name: "BAN SONG", exact: true })
    .click();
  await respond({ removed: true, uids: ["native-ban-uid"] });
  await surface
    .locator("#queue tr")
    .filter({ hasText: "TIDAL UI fixture" })
    .waitFor({ state: "detached" });
  await surface.locator("#videoInput").fill("Artist TIDAL UI fixture");
  await surface.locator("#addSong").click();
  await respond({
    candidate: {
      provider: "tidal",
      providerItemId: "123",
      title: "TIDAL UI fixture",
      artists: ["Artist"],
      durationMs: 180000,
    },
  });
  await surface
    .locator("#requestNotice")
    .filter({ hasText: "This track is banned" })
    .waitFor({ timeout: 5000 })
    .catch(async () => {
      throw new Error(
        "Ban admission: " +
          (await surface.locator("#requestNotice").innerText()) +
          "; notice:" +
          (await surface.locator("#notice").innerText()) +
          "; errors:" +
          JSON.stringify(errors) +
          "; registry:" +
          JSON.stringify(
            created.extension.registry
              .list()
              .features.map(({ lifecycle, error }) => ({ lifecycle, error })),
          ),
      );
    });
  await surface.locator('#tidalNowControls[data-current-uid="native-ui-uid-next"]').waitFor();
  await surface
    .locator("#tidalNowControls")
    .getByRole("button", { name: "BAN CURRENT SONG", exact: true })
    .click();
  await respond({ removed: true, uids: ["native-ui-uid-next"] });
  await surface
    .locator("#notice")
    .filter({ hasText: "Current song banned" })
    .waitFor({ timeout: 5000 })
    .catch(async () => {
      throw new Error("Current ban result: " + (await surface.locator("#notice").innerText()));
    });
  await surface.locator('#tidalNowControls[data-current-uid="native-ui-uid-next-next"]').waitFor();
  await surface.locator("#tidalNowControls").getByLabel("Song timeout duration").selectOption("5");
  await surface
    .locator("#tidalNowControls")
    .getByRole("button", { name: "TIMEOUT SONG", exact: true })
    .click();
  await respond({ removed: true, uids: ["native-ui-uid-next-next"] });
  await surface.locator("#notice").filter({ hasText: "Current song timed out" }).waitFor();
  await surface.locator("#videoInput").fill("125");
  await surface.locator("#addSong").click();
  await respond({
    candidate: {
      provider: "tidal",
      providerItemId: "125",
      title: "Timed track",
      artists: ["Artist"],
      durationMs: 180000,
    },
  });
  await surface.locator("#requestNotice").filter({ hasText: "temporarily blocked" }).waitFor();
  await surface
    .locator('[data-choice-for="songPlayerProvider"] [data-choice-value="youtube"]')
    .click();
  await surface
    .locator('[data-choice-for="songPlayerProvider"] [data-choice-value="youtube"]:not([disabled])')
    .waitFor();
  assert.equal(await surface.locator("#playerFrame").isVisible(), true);
  assert.equal(await surface.locator("#tidalPlayer").isHidden(), true);
  await surface.getByRole("tab", { name: "Setup", exact: true }).click();
  assert.equal(await surface.locator("#catalogSettings").isVisible(), true);
  assert.equal(await surface.locator("#tidalCatalogSetup").isHidden(), true);
  await surface.getByRole("tab", { name: "Moderation", exact: true }).click();
  assert.equal(await surface.locator("#viewerLimit").isVisible(), true);
  assert.equal(
    await surface.locator("#volumeCeiling").isHidden(),
    true,
    "output range belongs beside Playback volume",
  );
  assert.equal(await surface.locator("#minimumViews").isVisible(), true);
  await surface.getByRole("tab", { name: "Playback", exact: true }).click();
  assert.equal(await surface.locator("#volumeCeiling").isVisible(), true);
  assert.equal(await surface.locator("#playerFrame").getAttribute("data-retained"), "yes");
  assert.deepEqual(errors, []);
  assert.equal(created.extension.registry.list().features[0].error, "");
});

test("local player waits for a user start, then plays and permits re-request after skip", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-player-"));
  const installed = path.join(root, "installed", "song-request");
  fs.cpSync(path.join(__dirname, "..", "features", "song-request"), installed, {
    recursive: true,
  });
  const created = createCoreServer({
    rootDir: path.join(__dirname, ".."),
    runtimeDir: path.join(root, "runtime"),
    dryRun: true,
    capabilities: { features: true },
    extend: createFeaturePlatformExtension({
      featuresRoot: path.join(root, "installed"),
      runtimeRoot: path.join(root, "runtime", "features"),
      allowUnsafeRuntime: true,
      providers: {
        "youtube.catalog.host.v1/status": async () => ({
          ok: true,
          configured: true,
          mode: "keyless",
          keyless: { version: "test" },
        }),
        "youtube.catalog.host.v1/resolve": async () => ({
          ok: true,
          candidate: VIDEO,
        }),
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
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });

  const context = await browser.newContext();
  await context.route("https://www.youtube.com/iframe_api", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `window.YT={PlayerState:{PLAYING:1,ENDED:0},Player:function(id,options){
      const api={setVolume(){},stopVideo(){api.stops=(api.stops||0)+1},getCurrentTime(){return 1},getDuration(){return 180},
        loadVideoById(videoId){api.videoId=videoId;setTimeout(()=>options.events.onStateChange({data:1}),0)},
        playVideo(){setTimeout(()=>options.events.onStateChange({data:1}),0)}};
      window.__testYT=api;setTimeout(()=>options.events.onReady({target:api}),0);return api}};window.onYouTubeIframeAPIReady();`,
    }),
  );
  const page = await context.newPage();
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.goto(`${base}/features-ui/song-request/player`);
  const surface = page.locator("#surface").contentFrame();
  await surface.locator("#startPlayer").filter({ hasText: "PLAY" }).waitFor();

  const add = async () => {
    await surface.locator("#videoInput").fill("playback fixture");
    await surface.locator("#addSong").click();
    await surface.locator("#requestNotice").filter({ hasText: "Added Playback fixture" }).waitFor();
  };
  const status = (capability) =>
    fetch(`${base}/api/features/song-request/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capability, method: "status", payload: {} }),
    })
      .then((response) => response.json())
      .then((body) => body.value);

  await add();
  assert.equal(
    await surface
      .locator("#queue .rowActions button")
      .evaluateAll((buttons) =>
        buttons.every((button) => getComputedStyle(button).whiteSpace === "nowrap"),
      ),
    true,
  );
  assert.equal((await status("song.playback.read.v1")).primary, null);
  await surface.locator("#startPlayer").click();
  await assert.doesNotReject(async () => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if ((await status("song.playback.read.v1")).primary?.status === "playing") return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("playback_not_started");
  });
  const beforeTabs = await status("song.playback.read.v1");
  await surface.locator("body").evaluate(() => {
    window.__retainedPlayer = window.__testYT;
    window.__stopsBeforeTabs = window.__testYT.stops || 0;
  });
  await surface.getByRole("tab", { name: "Moderation", exact: true }).click();
  await surface.locator("#viewerLimit").fill("7");
  await surface.getByRole("tab", { name: "Moderation", exact: true }).press("ArrowLeft");
  assert.equal(
    await surface.getByRole("tab", { name: "Setup", exact: true }).getAttribute("aria-selected"),
    "true",
  );
  await surface.getByRole("tab", { name: "Moderation", exact: true }).click();
  assert.equal(await surface.locator("#viewerLimit").inputValue(), "7");
  await surface.getByRole("tab", { name: "Playback", exact: true }).click();
  assert.equal(
    await surface
      .locator("body")
      .evaluate(
        () =>
          window.__retainedPlayer === window.__testYT &&
          (window.__testYT.stops || 0) === window.__stopsBeforeTabs,
      ),
    true,
  );
  const afterTabs = await status("song.playback.read.v1");
  assert.equal(afterTabs.managed.entryId, beforeTabs.managed.entryId);
  assert.equal(afterTabs.primary.status, "playing");
  const secondPage = await context.newPage();
  await secondPage.goto(`${base}/features-ui/song-request/player`);
  const secondSurface = secondPage.locator("#surface").contentFrame();
  await secondSurface.locator("#connection").filter({ hasText: "CONNECTED" }).waitFor();
  await secondSurface.locator("body").evaluate(async () => {
    while (!window.__testYT) await new Promise((resolve) => setTimeout(resolve, 10));
  });
  await secondSurface.locator("#refresh").click();
  assert.equal(
    await secondSurface.locator("body").evaluate(() => window.__testYT.videoId),
    undefined,
  );
  await secondPage.close();
  await surface.locator("#skip").click();
  await surface.locator("#queue").filter({ hasText: "QUEUE EMPTY" }).waitFor();
  await add();
  assert.equal((await status("song.queue.read.v1")).counts.queued, 1);
  await surface.locator("#clear").click();
  await surface.locator("#queue").filter({ hasText: "QUEUE EMPTY" }).waitFor();
  await surface.locator("body").evaluate(async () => {
    await moderate({ action: "remove", entryId: "missing-entry" }, "Song removed.");
  });
  assert.equal(await surface.locator("#notice").textContent(), "entry_not_found");
});
