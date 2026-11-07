const test = require("node:test"),
  assert = require("node:assert/strict"),
  path = require("node:path"),
  express = require("express");
const { chromium } = require("playwright");
test("fullscreen screens fit touch viewports, swipe without activating buttons, and honor opt-in keyboard controls", async (t) => {
  const app = express();
  app.use(require("./support/fixture-http-limit.cjs")());
  app.use(express.static(path.resolve(__dirname, "../public/core")));
  app.get("/navigation-fixture", (_req, res) =>
    res.type("html")
      .send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
    <link rel="stylesheet" href="/control-deck.css"><style>:root{--bg:#050507;--edge:#263554;--text:#fff}body{margin:0}.controlDeck{--deck-columns:6;--deck-tablet-columns:4;--deck-phone-columns:2;--deck-gap:14px;--deck-radius:30px;--deck-color:#a90036;--deck-text:#fff;--deck-aspect:1}.deckWidgetRegion{height:32px}</style>
    <section class="controlDeck" data-focus="true"><div class="deckWidgetRegion">Compact widget</div><div class="deckGrid"></div></section>
    <input id="typing" aria-label="Typing"><script type="module">
      import {createDeckPager} from '/control-deck-pager.js';import {installDeckKeys} from '/control-deck-keys.js';
      window.config={layout:{fullscreenMode:'pages',fullscreenSwipe:true,fullscreenKeyboard:true,previousKey:'ArrowLeft',nextKey:'ArrowRight',keyboardButtons:true},pages:[{buttons:[]}]};
      const host=document.querySelector('.controlDeck'),grid=host.querySelector('.deckGrid');window.presses=[];
      for(let i=0;i<40;i++){const b=document.createElement('button');b.className='deckButton';b.dataset.deckButton='button-'+i;b.textContent='Button '+i;b.onclick=()=>presses.push(i);grid.append(b);config.pages[0].buttons.push({id:'button-'+i,kind:'macro',activationKey:i===0?'KeyQ':''});}
      config.pages[0].id='quick';config.pages[0].name='Quick Access';window.currentPage='quick';
      const original=[...grid.children];
      window.pager=createDeckPager({host,getConfig:()=>config,getPageId:()=>currentPage,onPage:id=>{
        currentPage=id;host.dataset.page=id;if(id==='quick')grid.replaceChildren(...original);else{const b=document.createElement('button');b.className='deckButton';b.dataset.deckButton='audio';b.textContent='Audio mixer';grid.replaceChildren(b);}
      }});installDeckKeys({host,getConfig:()=>config,isEditing:()=>false,pager});pager.schedule();
    </script>`),
  );
  const server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    }),
    browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    }),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/navigation-fixture`);
  await page.waitForFunction(() => document.querySelector(".deckScreenNav:not([hidden])"));
  const initial = await page.locator(".deckScreenNav span").textContent();
  assert.match(initial, /^1 \/ [2-9]/);
  const bounds = await page
    .locator("[data-deck-button]:visible")
    .evaluateAll((buttons) => buttons.map((b) => b.getBoundingClientRect().bottom));
  assert(Math.max(...bounds) <= 844 - 40, "all visible buttons fit above fullscreen navigation");
  const client = await page.context().newCDPSession(page);
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: 320, y: 250 }],
  });
  await client.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: 250, y: 250 }],
  });
  await client.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: 80, y: 250 }],
  });
  assert.equal(
    await page.locator(".deckGrid").evaluate((grid) => grid.style.transform),
    "",
    "screen swipes do not animate or repaint the acrylic grid",
  );
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForFunction(() =>
    document.querySelector(".deckScreenNav span").textContent.startsWith("2 /"),
  );
  assert.deepEqual(await page.evaluate(() => presses), []);
  await page.keyboard.press("ArrowRight");
  assert.match(await page.locator(".deckScreenNav span").textContent(), /^3 \/ /);
  await page.keyboard.press("q");
  assert.deepEqual(await page.evaluate(() => presses), [0]);
  await page.evaluate(() => {
    config.pages.push({ id: "audio", name: "Audio mixer", buttons: [] });
    pager.move(999);
  });
  await page.waitForFunction(() =>
    document.querySelector(".deckScreenNav span").textContent.startsWith("Audio mixer"),
  );
  await page.getByRole("button", { name: "Previous screen", exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector(".deckScreenNav span").textContent.startsWith("Quick Access"),
  );
  assert.match(await page.locator(".deckScreenNav span").textContent(), /Quick Access/);
  assert.match(await page.locator(".deckScreenNav span").textContent(), /7 \/ 7/);
  await page.evaluate(() => (config.layout.keyboardButtons = false));
  await page.keyboard.press("q");
  assert.deepEqual(await page.evaluate(() => presses), [0]);
  await page.evaluate(() => {
    config.layout.fullscreenMode = "scroll";
    config.layout.fullscreenSwipe = false;
    config.layout.fullscreenKeyboard = false;
    pager.schedule();
  });
  await page.waitForFunction(() => document.querySelector(".deckScreenNav").hidden);
  assert.equal(await page.locator("[data-deck-button]:visible").count(), 40);
  await page.evaluate(() => {
    config.pages = config.pages.filter((page) => page.id === "quick");
    config.layout.fullscreenMode = "pages";
    pager.move(-999);
    pager.schedule();
  });
  for (const viewport of [
    { width: 820, height: 1180 },
    { width: 1180, height: 820 },
    { width: 1365, height: 1024 },
  ]) {
    await page.setViewportSize(viewport);
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const fit = await page.evaluate(() => {
      const visible = [...document.querySelectorAll("[data-deck-button]:not([hidden])")],
        hidden = document.querySelector("[data-deck-button][hidden]"),
        bottom = Math.max(...visible.map((button) => button.getBoundingClientRect().bottom)),
        grid = document.querySelector(".deckGrid");
      return {
        room: document.querySelector(".controlDeck").style.getPropertyValue("--deck-page-room"),
        gridTop: grid.getBoundingClientRect().top,
        count: visible.length,
        bottom,
        height: visible[0].getBoundingClientRect().height,
        gap: parseFloat(getComputedStyle(grid).gap),
        limit: document.querySelector(".deckScreenNav").getBoundingClientRect().top,
        more: !!hidden,
      };
    });
    assert(fit.bottom <= fit.limit + 1, "current rows fit above navigation");
    if (fit.more)
      assert(fit.bottom + fit.gap + fit.height > fit.limit, JSON.stringify({ viewport, fit }));
  }
  assert.deepEqual(errors, []);
});
