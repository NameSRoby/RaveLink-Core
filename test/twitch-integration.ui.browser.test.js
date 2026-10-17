const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const createCoreServer = require("../src/app/core/create-core-server");
const createFeaturePlatformExtension = require("../src/app/optional/create-feature-platform-extension");

test("Twitch Client ID administration is write-only and gated by HUD Developer Mode", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-twitch-ui-"));
  const installed = path.join(root, "installed", "twitch-integration");
  fs.cpSync(path.join(__dirname, "..", "features", "twitch-integration"), installed, {
    recursive: true,
  });
  let pending = false;
  let connected = false;
  let createFailure = false;
  let recovery = {
    reauthorizationRequired: false,
    reason: "",
    revocations: [],
  };
  let monitorConfig = {
    intakeMode: "streamelements",
    songRequestChatEnabled: false,
  };
  const managedRewards = [];
  const reviews = [
    {
      broadcasterId: "123",
      rewardId: "managed-song",
      redemptionId: "interrupted",
      phase: "review",
      desiredStatus: "",
      observedStatus: "",
      error: "twitch_interrupted_transaction",
      updatedAt: 1000,
    },
  ];
  const reconciled = [];
  const status = () => ({
    ok: true,
    configured: true,
    connected,
    authorizationRecovery: recovery,
    login: connected ? "tester" : "",
    userId: connected ? "123" : "",
    scopes: [],
    expiresAt: 0,
    authorizationPending: pending,
    userCode: pending ? "TEST-CODE" : "",
    verificationUri: pending ? "https://www.twitch.tv/activate?device-code=TEST-CODE" : "",
    nextPollAt: 0,
    authorizationExpiresAt: 0,
    requiredScopes: ["channel:manage:redemptions"],
    managedRewards: structuredClone(managedRewards),
    monitorConfig: { ...monitorConfig },
    vault: "windows_dpapi",
    lastError: "",
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
        "twitch.host.v1/review-transactions": () => ({
          ok: true,
          total: reviews.length,
          entries: structuredClone(reviews),
        }),
        "twitch.host.v1/reconcile-transaction": (payload) => {
          reconciled.push(payload);
          reviews.splice(0);
          return { ok: true, status: payload.status };
        },
        "twitch.host.v1/status": status,
        "twitch.host.v1/configure-monitor": (payload) => {
          monitorConfig = { ...payload };
          return status();
        },
        "twitch.host.v1/begin": () => {
          pending = true;
          return status();
        },
        "twitch.host.v1/poll": () => {
          pending = false;
          connected = true;
          return status();
        },
        "twitch.host.v1/create-reward": (payload) => {
          if (createFailure) return { ok: false, error: "twitch_reward_creation_in_progress" };
          const reward = {
            ok: true,
            purpose: payload.purpose,
            rewardId: `managed-${payload.purpose}`,
            title: payload.title,
            cost: payload.cost,
            manageable: true,
          };
          managedRewards.push(reward);
          return reward;
        },
      },
    }),
  });
  await created.extension.startup;
  const server = await new Promise((resolve) => {
    const listener = created.app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await created.extension.shutdown();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  await page.context().route("https://www.twitch.tv/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<title>Twitch authorization</title>",
    }),
  );
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`, {
    waitUntil: "domcontentloaded",
  });
  const twitchTab = page.getByRole("button", { name: "TWITCH INTEGRATION" });
  await twitchTab.waitFor();
  await twitchTab.click();

  const contribution = page.frameLocator("iframe.featurePageFrame").frameLocator("#surface");
  const developerSection = contribution.locator("#developerApplication");
  await developerSection.waitFor({ state: "attached" });
  assert.equal(await developerSection.isHidden(), true);
  const coreAccent = await page
    .locator("html")
    .evaluate((node) => getComputedStyle(node).getPropertyValue("--accent").trim());
  const featureAccent = await contribution
    .locator("html")
    .evaluate((node) => getComputedStyle(node).getPropertyValue("--accent").trim());
  assert.equal(featureAccent, coreAccent);

  await page.locator("#themeButton").click();
  await page.locator("#developerMode").check();
  await developerSection.waitFor({ state: "visible" });
  assert.equal(await contribution.locator("#clientId").getAttribute("type"), "password");
  assert.equal(await contribution.getByText("SHOW CLIENT ID").count(), 0);
  assert.equal(await contribution.locator("#clearClientId").isEnabled(), true);
  const popupPromise = page.context().waitForEvent("page");
  await contribution.locator("#begin").click();
  const popup = await popupPromise;
  await popup.waitForURL(/^https:\/\/www\.twitch\.tv\/activate\?device-code=TEST-CODE/);
  assert.match(popup.url(), /^https:\/\/www\.twitch\.tv\/activate\?device-code=TEST-CODE/);
  await popup.close();
  await contribution.locator("#check").click();
  await contribution.locator("#state").filter({ hasText: "CONNECTED" }).waitFor();
  assert.equal(await contribution.locator("#intakeMode").inputValue(), "streamelements");
  assert.equal(await contribution.locator('[data-choice-for="intakeMode"] .choiceCard').count(), 2);
  assert.equal(
    await contribution.locator('[data-choice-for="rewardPurpose"] .choiceCard').count(),
    4,
  );
  assert.equal(await contribution.locator("#songRequestIntake").isVisible(), false);
  assert.equal(await contribution.locator("#managedRewardSection").isVisible(), false);
  assert.equal(await contribution.locator("#createReward").isDisabled(), true);
  await contribution
    .locator(".task-navigation")
    .getByRole("button", { name: "Event intake", exact: true })
    .click();
  await contribution.locator("#intakeMode").selectOption("native");
  assert.equal(
    await contribution
      .locator('[data-choice-for="intakeMode"] [data-value="native"]')
      .getAttribute("aria-pressed"),
    "true",
  );
  assert.equal(await contribution.locator("#songRequestIntake").isVisible(), true);
  assert.equal(
    await contribution.locator("#managedRewardSection").evaluate((el) => !el.hidden),
    true,
  );
  assert.equal(
    await contribution.locator('[data-command="volume"][data-role="moderator"]').isChecked(),
    true,
  );
  assert.equal(
    await contribution.locator('[data-command="volume"][data-role="vip"]').isChecked(),
    false,
  );
  assert.equal(
    await contribution.locator('[data-command="remove"][data-role="viewer"]').isChecked(),
    true,
  );
  assert.equal(
    await contribution.locator('[data-command="removeAny"][data-role="viewer"]').isChecked(),
    false,
  );
  await contribution.locator('[data-command="volume"][data-role="vip"]').check();
  await contribution.locator("#saveMonitor").click();
  await contribution
    .locator("#monitorNotice")
    .filter({ hasText: "SERVER INTAKE ACTIVE" })
    .waitFor();
  assert.equal(monitorConfig.intakeMode, "native");
  assert.equal(monitorConfig.commandPermissions.volume.vip, true);
  assert.equal(monitorConfig.commandPermissions.removeAny.viewer, false);
  await contribution
    .locator(".task-navigation")
    .getByRole("button", { name: "Rewards", exact: true })
    .click();
  await contribution.locator("#createReward").click();
  assert.equal(
    await contribution.getByLabel("RaveLink: Change Lights reward ID").inputValue(),
    "managed-lights",
  );
  assert.equal(await page.locator("#colorRewardId").inputValue(), "");
  await contribution.locator("#rewardPurpose").selectOption("teach");
  await contribution.locator("#createReward").click();
  assert.equal(
    await contribution.getByLabel("RaveLink: Teach Color reward ID").inputValue(),
    "managed-teach",
  );
  assert.equal(await page.locator("#teachRewardId").inputValue(), "");
  await contribution.locator("#rewardPurpose").selectOption("song_request");
  assert.equal(await contribution.locator("#rewardTitle").inputValue(), "RaveLink: Song Request");
  assert.match(await contribution.locator("#rewardPrompt").inputValue(), /artist and song/);
  createFailure = true;
  await contribution.locator("#createReward").click();
  await contribution
    .locator("#rewardNotice")
    .filter({ hasText: "twitch_reward_creation_in_progress" })
    .waitFor();
  assert.equal(await contribution.locator("#createReward").isEnabled(), true);
  assert.equal(managedRewards.length, 2);
  createFailure = false;
  await contribution.locator("#createReward").click();
  assert.equal(
    await contribution.getByLabel("RaveLink: Song Request reward ID").inputValue(),
    "managed-song_request",
  );
  assert.equal(await page.locator("#songRewardId").inputValue(), "");
  await contribution
    .locator(".task-navigation")
    .getByRole("button", { name: "Review", exact: true })
    .click();
  await contribution.getByRole("button", { name: "REFUND POINTS", exact: true }).click();
  await contribution
    .locator("#transactionNotice")
    .getByText("Twitch confirms CANCELED.", { exact: true })
    .waitFor();
  assert.deepEqual(reconciled, [
    {
      broadcasterId: "123",
      rewardId: "managed-song",
      redemptionId: "interrupted",
      status: "CANCELED",
    },
  ]);
  assert.equal(await contribution.locator("#transactions button").count(), 0);
  recovery = {
    reauthorizationRequired: true,
    reason: "authorization_revoked",
    revocations: [{ type: "channel.cheer", version: "1", reason: "authorization_revoked" }],
  };
  connected = false;
  await contribution
    .locator(".task-navigation")
    .getByRole("button", { name: "Connection", exact: true })
    .click();
  await contribution.locator("#refresh").click();
  await contribution.locator("#state").filter({ hasText: "RECONNECT REQUIRED" }).waitFor();
  assert.equal(await contribution.locator("#begin").isEnabled(), true);
  assert.equal(await contribution.locator("#begin").textContent(), "REAUTHORIZE TWITCH");
  assert.equal(await contribution.locator("#createReward").isDisabled(), true);
  assert.match(
    await contribution.locator("#authorizationRecovery").textContent(),
    /New events are stopped/,
  );
  connected = true;
  recovery = {
    reauthorizationRequired: false,
    reason: "",
    revocations: [{ type: "channel.cheer", version: "1", reason: "version_removed" }],
  };
  await contribution
    .locator(".task-navigation")
    .getByRole("button", { name: "Connection", exact: true })
    .click();
  await contribution.locator("#refresh").click();
  await contribution
    .locator(".task-navigation")
    .getByRole("button", { name: "Event intake", exact: true })
    .click();
  await contribution.locator("#monitorState").filter({ hasText: "DEGRADED" }).waitFor();
  assert.match(
    await contribution.locator("#authorizationRecovery").textContent(),
    /retired version 1/,
  );
  assert.equal(await contribution.locator("#state").textContent(), "CONNECTED");
  recovery = { reauthorizationRequired: false, reason: "", revocations: [] };
  await contribution
    .locator(".task-navigation")
    .getByRole("button", { name: "Connection", exact: true })
    .click();
  await contribution.locator("#refresh").click();
  await contribution.locator("#authorizationRecovery").waitFor({ state: "hidden" });
  await contribution
    .locator(".task-navigation")
    .getByRole("button", { name: "Rewards", exact: true })
    .click();
  for (const viewport of [
    { width: 1280, height: 600 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await contribution
      .locator("body")
      .evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
    await contribution.locator("body").evaluate(
      () =>
        new Promise((resolve, reject) => {
          const at = Date.now();
          const check = () =>
            Math.abs(document.body.getBoundingClientRect().height - innerHeight) < 2
              ? resolve()
              : Date.now() - at > 5000
                ? reject(Error("frame did not fit content"))
                : setTimeout(check, 30);
          check();
        }),
    );
    await page.waitForFunction(() => {
      const wrapper = document.querySelector("iframe.featurePageFrame");
      const inner = wrapper?.contentDocument?.querySelector("#surface");
      return (
        inner &&
        Math.abs(inner.getBoundingClientRect().height - wrapper.getBoundingClientRect().height) < 2
      );
    });
    const geometry = await contribution.locator("body").evaluate((body) => ({
      content: body.getBoundingClientRect().height,
      viewport: innerHeight,
      overflow: getComputedStyle(document.documentElement).overflowY,
    }));
    assert.ok(geometry.content <= geometry.viewport + 1, JSON.stringify(geometry));
    assert.equal(geometry.overflow, "hidden");
    await page.evaluate(() => scrollTo(0, 0));
    const box = await page.locator("iframe.featurePageFrame").boundingBox();
    await page.mouse.move(box.x + box.width / 2, Math.min(viewport.height - 80, box.y + 120));
    await page.mouse.wheel(0, 500);
    await page.waitForFunction(() => scrollY > 100);
    assert.equal(
      await contribution.locator("html").evaluate(() => document.scrollingElement.scrollTop),
      0,
    );
    const lastSection = contribution.locator("#managedRewardSection");
    await lastSection.scrollIntoViewIfNeeded();
    assert.equal(
      await contribution.locator("html").evaluate(() => document.scrollingElement.scrollTop),
      0,
    );
    assert.ok(await page.evaluate(() => scrollY > 100));
  }
  const standalone = await browser.newPage({
    viewport: { width: 390, height: 844 },
  });
  await standalone.goto(
    `http://127.0.0.1:${server.address().port}/features-ui/twitch-integration/connection`,
  );
  await standalone
    .frameLocator("#surface")
    .locator(".task-navigation")
    .getByRole("button", { name: "Rewards", exact: true })
    .click();
  await standalone.waitForFunction(
    () => document.querySelector("#surface").getBoundingClientRect().height > innerHeight,
  );
  const standaloneContent = standalone.frameLocator("#surface");
  const standaloneSize = await standaloneContent.locator("body").evaluate((body) => ({
    content: body.getBoundingClientRect().height,
    viewport: innerHeight,
  }));
  assert.ok(standaloneSize.content <= standaloneSize.viewport + 1, JSON.stringify(standaloneSize));
  await standalone.mouse.move(200, 400);
  await standalone.mouse.wheel(0, 500);
  await standalone.waitForFunction(() => scrollY > 100);
  assert.equal(
    await standaloneContent.locator("html").evaluate(() => document.scrollingElement.scrollTop),
    0,
  );
  await standalone.close();
  assert.deepEqual(errors, []);
});
