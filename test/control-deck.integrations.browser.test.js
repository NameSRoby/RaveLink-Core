/** Integration UI uses fake Core responses; no desktop automation or Twitch
 * authorization/clip operation is performed by this test.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const { chromium } = require("playwright");
test("Discord setup only connects mute and deafen without owning the app lifecycle", async (t) => {
  const app = express();
  const clips = require("../src/domains/twitch/twitch-clips.service")({
    getProvider: () => ({ status: () => ({ connected: true, scopes: ["clips:edit"] }) }),
  });
  app.use(express.json());
  app.post("/api/control-deck/integrations/twitch-clips/preview", (req, res) =>
    res.json(clips.previewTitle(req.body)),
  );
  app.post("/api/control-deck/integrations/twitch-clips/configure", (req, res) =>
    res.json(clips.configure(req.body)),
  );
  app.use(require("./support/fixture-http-limit.cjs")());
  app.get("/integrations.js", (_req, res) =>
    res
      .type("application/javascript")
      .send(
        fs.readFileSync(
          path.join(__dirname, "../public/core/control-deck-integrations.js"),
          "utf8",
        ),
      ),
  );
  app.get("/deck.css", (_req, res) =>
    res
      .type("css")
      .send(fs.readFileSync(path.join(__dirname, "../public/core/control-deck.css"), "utf8")),
  );
  app.get("/", (_req, res) =>
    res.type("html")
      .send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/deck.css"><style>:root{--panel:#0b0e18;--surface:#11182a;--bg:#050507;--edge:#263554;--text:#fff;--accent:#a90036;--muted:#9ab2d6}body{background:var(--bg);color:var(--text);font:16px Arial}</style></head><body><button id="open">Open integrations</button><script type="module">
import {createDeckIntegrations} from '/integrations.js';
window.calls=[];
window.snapshot={discord:{available:true,bound:true,muted:false},twitchClips:{connected:true,scopeGranted:true,config:{chatEnabled:false,chatAccess:'everyone'}}};
const ui=createDeckIntegrations({request:async(url,method='GET',body)=>{
  window.calls.push({url,method,body});
  if(method==='GET')return structuredClone(window.snapshot);
  return fetch(url,{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json());
},refresh:async()=>{},onTwitchSetup:()=>{window.settingsOpened=true;return true}});
document.getElementById('open').onclick=()=>ui.open();
</script></body></html>`),
  );
  const server = await new Promise((resolve) => {
    const value = app.listen(0, "127.0.0.1", () => resolve(value));
  });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://127.0.0.1:" + server.address().port);
  await page.locator("#open").click();
  await page.getByRole("heading", { name: "Keyboard buttons", exact: true }).waitFor();
  assert.equal(
    await page.locator("#deckDiscordPrepare, #deckStreamerEnable, #deckStreamerDisable").count(),
    0,
  );
  assert.equal(await page.evaluate(() => calls.filter((c) => c.method === "POST").length), 0);
  assert.equal(await page.locator("#deckDiscordBind").count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator("#deckTwitchTab").click();
  assert.equal(await page.locator("#deckDiscordPanel").isVisible(), false);
  assert.equal(await page.locator("#deckClipFilter").isChecked(), true);
  await page.locator(".deckClipPolicy summary").click();
  await page.locator("#deckClipBlocked").fill("spoiler");
  await page.locator("#deckClipPreviewTitle").fill("spoiler clutch");
  await page.locator("#deckClipPreview").click();
  await page.waitForFunction(() =>
    document.getElementById("deckClipPreviewResult").textContent.includes("**** clutch"),
  );
  assert.equal(clips.status().job, null);
  assert.deepEqual(clips.status().config.titleModeration.blockedWords, []);
  assert.equal(
    await page.locator("#deckClipBlocked").inputValue(),
    "spoiler",
    "preview retains the draft",
  );
  await page.locator("#deckClipFilterMode").selectOption("reject");
  await page.locator("#deckClipPreview").click();
  await page.waitForFunction(() =>
    document.getElementById("deckClipPreviewResult").textContent.includes("rejected"),
  );
  await page.locator("#deckClipSaveFilter").click();
  await page.waitForFunction(() =>
    document.getElementById("deckIntegrationNotice").textContent.includes("saved"),
  );
  assert.deepEqual(clips.status().config.titleModeration.blockedWords, ["spoiler"]);
  assert.equal(clips.status().config.titleModeration.mode, "reject");
  const overflow = await page
    .locator("#deckIntegrations")
    .evaluate((el) => el.scrollWidth > el.clientWidth);
  assert.equal(overflow, false, "filter editor fits a phone viewport");
  await page.locator("#deckClipAuthorize").click();
  await page.locator("#deckIntegrations").waitFor({ state: "hidden" });
  assert.equal(
    await page.evaluate(() => window.settingsOpened),
    true,
    "clip setup opens the unified Twitch connection",
  );
  assert.deepEqual(errors, []);
});

test("mock HTTP limits reject excess requests before resource work and stay isolated per harness", async (t) => {
  const createLimit = require("./support/fixture-http-limit.cjs");
  let reads = 0;
  async function fixture() {
    const app = express();
    app.use(createLimit({ limit: 2 }));
    app.get("/resource", (_req, res) => {
      reads++;
      res.send("fixture resource");
    });
    const server = await new Promise((resolve) => {
      const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    return "http://127.0.0.1:" + server.address().port;
  }
  const first = await fixture(),
    second = await fixture();
  for (let count = 0; count < 2; count++)
    assert.equal((await fetch(first + "/resource")).status, 200);
  const rejected = await fetch(first + "/resource");
  assert.equal(rejected.status, 429);
  assert.equal((await rejected.json()).error, "fixture_http_rate_limited");
  assert.equal(reads, 2, "rate-limited requests cannot invoke the resource handler");
  assert.equal((await fetch(second + "/resource")).status, 200);
  assert.equal(reads, 3, "a new harness has an independent budget");
});
