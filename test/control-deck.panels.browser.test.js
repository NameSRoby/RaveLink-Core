/** Fake providers cover quick-panel intent without issuing hardware/account actions. */
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  express = require("express");
const { chromium } = require("playwright");
test("reward and light panels support individual, all and pinned controls without secure-context UUIDs", async (t) => {
  const app = express();
  app.use(require("./support/fixture-http-limit.cjs")());
  for (const [url, file, type] of [
    ["/browser-random-id.js", "browser-random-id.js", "js"],
    ["/panels.js", "control-deck-panels.js", "js"],
    ["/control-deck-windows-panel.js", "control-deck-windows-panel.js", "js"],
    ["/control-deck-slider.js", "control-deck-slider.js", "js"],
    ["/control-deck-id.js", "control-deck-id.js", "js"],
    ["/deck.css", "control-deck.css", "css"],
  ])
    app.get(url, (_req, res) =>
      res.type(type).send(fs.readFileSync(path.join(__dirname, "../public/core", file), "utf8")),
    );
  app.get("/", (_req, res) =>
    res.type("html")
      .send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/deck.css"><style>:root{--bg:#050507;--panel:#0b0e18;--surface:#10182a;--edge:#263554;--text:#fff;--muted:#a3b4d1}body{background:var(--bg);color:var(--text);font:16px Arial}</style></head><body><button id="rewards">Rewards</button><button id="lights">Lights</button><script type="module">
import {createDeckPanels} from '/panels.js';
window.calls=[];window.config={version:1,mode:'deck',columns:5,pages:[{id:'quick',name:'Quick Access',buttons:[]}]};
window.rewardState={available:true,rewards:[{id:'reward-lights',purpose:'lights',title:'Change lights',cost:100,paused:false,manageable:true},{id:'reward-song',purpose:'song_request',title:'Song Request',cost:200,paused:false,manageable:true}]};
const ui=createDeckPanels({getConfig:()=>config,getPageId:()=> 'quick',save:async value=>{window.config=value},refresh:async()=>{},explain:error=>error.message,request:async(url,method='GET',body)=>{
 calls.push({url,method,body});
 if(url==='/fixtures')return {fixtures:[{id:'lamp-1',name:'Desk lamp',enabled:true}]};
 if(url==='/color')return {ok:true,sent:1,failed:0};
 if(method==='GET')return structuredClone(rewardState);
 const results=[];for(const row of rewardState.rewards){if(body.purpose!=='all'&&body.purpose!==row.purpose)continue;if(!body.paused&&row.purpose==='song_request'){results.push({purpose:row.purpose,ok:false,held:true});continue}row.paused=body.paused;results.push({purpose:row.purpose,ok:true})}
 return {ok:true,state:structuredClone(rewardState),results,partial:results.some(r=>!r.ok)};
}});
document.getElementById('rewards').onclick=()=>ui.open('rewards');document.getElementById('lights').onclick=()=>ui.open('lights');
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
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } }),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() =>
    Object.defineProperty(globalThis.crypto, "randomUUID", { value: undefined }),
  );
  await page.goto("http://127.0.0.1:" + server.address().port);
  await page.locator("#rewards").click();
  assert.equal(
    await page.evaluate(() => calls.some((c) => c.method === "POST")),
    false,
    "opening quick controls never changes an account or fixture",
  );
  await page.getByRole("button", { name: "Pause Change lights", exact: true }).click();
  await page.getByRole("button", { name: "Resume Change lights", exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => calls.find((c) => c.method === "POST").body), {
    purpose: "lights",
    paused: true,
    rewardId: "reward-lights",
  });
  await page.getByRole("button", { name: "Add a toggle for Change lights", exact: true }).click();
  await page.waitForFunction(() => config.pages[0].buttons.length === 1);
  assert.equal(
    await page.evaluate(() => config.pages[0].buttons[0].steps[0].actionId),
    "rewards.toggle:reward-lights",
  );
  await page.locator("#deckRewardsToggleAll").click();
  await page.getByRole("button", { name: "Resume all rewards", exact: true }).waitFor();
  await page.locator("#deckRewardsToggleAll").click();
  await page.getByText(/Song rewards remain paused/).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Resume Song Request", exact: true }).isVisible(),
    true,
  );
  await page.locator("#deckControlPanelClose").click();
  await page.locator("#lights").click();
  await page.locator("#deckLightScope").selectOption("lamp-1");
  await page.locator("#deckLightColor").fill("#33aaff");
  await page.locator("#deckLightLevel").fill("37");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await page.getByText("Manual light command sent.", { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => calls.find((c) => c.url === "/color").body), {
    text: "#33aaff 37%",
    target: "both",
    fixtureId: "lamp-1",
  });
  await page.getByRole("button", { name: "+ Add this setting to deck", exact: true }).click();
  await page.waitForFunction(() => config.pages[0].buttons.length === 2);
  assert.deepEqual(await page.evaluate(() => config.pages[0].buttons[1].steps[0].params), {
    scope: "fixture",
    fixtureId: "lamp-1",
    color: "#33aaff",
    brightness: 37,
  });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
});
