const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

const createCoreServer = require("../src/app/core/create-core-server");
const createModPlatformExtension = require("../src/app/optional/create-mod-platform-extension");
const createDefaultPlatformExtension = require("../src/app/optional/create-default-platform-extension");
const { createPackage } = require("./helpers/mod-package-fixture");
const {
  hashFileSha256,
} = require("../src/capabilities/mod-platform/packages/mod-package-integrity");

test("normal app detects a dropped mod and one confirmation docks its button", async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-mod-dock-"));
  const appRoot = path.resolve(__dirname, "..");
  const created = createCoreServer({
    rootDir: appRoot,
    runtimeDir: path.join(temporary, "runtime"),
    dryRun: true,
    capabilities: { mods: true, features: true },
    extend: createDefaultPlatformExtension({
      rootDir: appRoot,
      inboxRoot: path.join(temporary, "mods"),
      featuresRoot: path.join(temporary, "features", "installed"),
      packageRoots: [],
      remoteSources: [],
    }),
  });
  let browser, server;
  t.after(async () => {
    await browser?.close();
    await created.services.lifecycle.stopAll();
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  await created.extension.startup;
  await created.extension.mods.inbox.ready();
  server = await new Promise((resolve) => {
    const s = created.app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  let confirmations = 0;
  page.on("dialog", async (dialog) => {
    confirmations++;
    await dialog.accept();
  });
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.locator("#moreNav > summary").click();
  await page.locator("#modsTab").click();
  fs.cpSync(
    path.join(appRoot, "packages/mod-sdk/starter"),
    path.join(temporary, "mods", "my-button"),
    { recursive: true },
  );
  await page
    .locator("#modInboxRows")
    .getByRole("button", { name: "Activate", exact: true })
    .click();
  await page.waitForFunction(() =>
    document.getElementById("modNotice").textContent.includes(": ACTIVE"),
  );
  assert.equal(confirmations, 1);
  const catalog = await fetch(base + "/api/control-deck/catalog").then((r) => r.json());
  assert(catalog.value.actions.some((a) => a.id === "mod:example.button:toggle" && a.available));
  const result = await created.extension.mods.registry.invokeAction("example.button", "toggle", {});
  assert(result.ok);
  assert.equal(result.value.enabled, true);
});

test("management UI loads an approved contribution only when opened", async (t) => {
  const rootDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ravelink-mod-ui-browser-"));
  const appRoot = path.resolve(__dirname, "..");
  const source = path.join(rootDir, "source");
  await createPackage(source, {
    permissions: { ui: true },
    source:
      "module.exports={activate(){},handleRequest({payload}){return {ok:true,text:payload.text}},deactivate(){}};\n",
  });
  await fs.promises.mkdir(path.join(source, "ui"));
  await fs.promises.writeFile(
    path.join(source, "ui", "status.html"),
    '<!doctype html><head><title>Status</title><link rel="stylesheet" href="./status.css"></head><body><p>lazy panel ready</p><button id="echo">Call mod</button><button id="denied">Try undeclared API</button><output></output><script src="./status.js"></script></body>',
    "utf8",
  );
  await fs.promises.writeFile(
    path.join(source, "ui/status.css"),
    "button { color: rgb(10, 20, 30); }",
  );
  await fs.promises.writeFile(
    path.join(source, "ui/status.js"),
    'const literal="$&";echo.onclick=async()=>{try{const result=await ravelink.call("example.service.v1","echo",{text:literal === "$&" ? "UI API works" : "bad replacement"});document.querySelector("output").textContent=result.text;}catch(error){document.querySelector("output").textContent=error.message;}};denied.onclick=async()=>{try{await ravelink.call("ravelink.controls.v1","catalog",{});}catch(error){document.querySelector("output").textContent=error.message;}}',
  );
  const manifestPath = path.join(source, "ravelink.mod.json");
  const manifest = JSON.parse(await fs.promises.readFile(manifestPath, "utf8"));
  manifest.contributes = {
    panels: [{ id: "status", title: "Status", entry: "ui/status.html" }],
  };
  manifest.integrity.files["ui/status.html"] = await hashFileSha256(
    path.join(source, "ui", "status.html"),
  );
  for (const file of ["ui/status.css", "ui/status.js"])
    manifest.integrity.files[file] = await hashFileSha256(path.join(source, file));
  await fs.promises.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const created = createCoreServer({
    rootDir: appRoot,
    runtimeDir: path.join(rootDir, "runtime"),
    dryRun: true,
    capabilities: { mods: true },
    extend: createModPlatformExtension({
      rootDir: appRoot,
      runtimeRoot: path.join(rootDir, "runtime", "mods"),
      modsRoot: path.join(rootDir, "runtime", "mods", "installed"),
      inboxRoot: path.join(rootDir, "mod"),
    }),
  });
  let server, browser;
  t.after(async () => {
    if (browser) await browser.close();
    await created.services.lifecycle.stopAll();
    if (server) await new Promise((resolve) => server.close(resolve));
    await fs.promises.rm(rootDir, { recursive: true, force: true });
  });
  const installed = await created.extension.packageManager.install(source);
  await created.extension.packageManager.approve(installed.modId, installed.approval.fingerprint);
  created.extension.registry.discover();
  const enabled = await created.extension.registry.enable(installed.modId, {
    allowUnsafeRuntime: true,
  });
  assert.equal(enabled.lifecycle, "active");
  server = await new Promise((resolve) => {
    const listener = created.app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const apiSnapshot = await fetch(
    `http://127.0.0.1:${server.address().port}/api/mod-platform`,
  ).then((response) => response.json());
  assert.equal(
    apiSnapshot.mods.find((mod) => mod.id === installed.modId).uiContributions[0].title,
    "Status",
  );
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
  });
  const panelRequests = [];
  const browserErrors = [];
  page.on("request", (request) => {
    if (request.url().includes("/mods-ui/")) panelRequests.push(request.url());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`, {
    waitUntil: "domcontentloaded",
  });
  await page.locator("#modsTab").waitFor({ state: "attached" });
  await page.waitForFunction(() => document.getElementById("modsTab")?.hidden === false);
  await page.locator("#moreNav > summary").click();
  await page.locator("#modsTab").click();
  await page.locator("#refreshMods").click();
  await page
    .getByRole("button", { name: "Status" })
    .waitFor({ timeout: 3000 })
    .catch(async () => {
      const current = await page.evaluate(() =>
        fetch("/api/mod-platform").then((response) => response.json()),
      );
      assert.fail(
        `${browserErrors.join(" | ")} // ${JSON.stringify(current.mods.find((mod) => mod.id === installed.modId)?.uiContributions)} // ${await page.locator("#modRows").innerText()}`,
      );
    });
  assert.deepEqual(panelRequests, []);
  assert.equal(await page.locator("#modUiSurface").isVisible(), false);

  await page.getByRole("button", { name: "Status" }).click();
  await page.locator("#modUiFrame").contentFrame().getByText("lazy panel ready").waitFor();
  assert.equal(panelRequests.length, 1);
  assert.equal(await page.locator("#modUiSurface").isVisible(), true);
  assert.equal(await page.locator("#modUiFrame").getAttribute("sandbox"), "allow-scripts");
  const panel = page.locator("#modUiFrame").contentFrame();
  assert.equal(
    await panel.locator("#echo").evaluate((el) => getComputedStyle(el).color),
    "rgb(10, 20, 30)",
  );
  await panel.getByRole("button", { name: "Call mod" }).click();
  await panel.getByText("UI API works", { exact: true }).waitFor();
  await panel.getByRole("button", { name: "Try undeclared API" }).click();
  await page.waitForFunction(() => document.getElementById("modUiSurface").hidden === false);
  await panel.locator("output").filter({ hasText: "capability_not_declared" }).waitFor();
  await created.extension.registry.disable(installed.modId);
  await panel.getByRole("button", { name: "Call mod" }).click();
  await panel.locator("output").filter({ hasText: "mod_ui_inactive" }).waitFor();
});
