/** Synthetic backdrop only; uploaded user media is never read by this test. */
const test = require("node:test"),
  assert = require("node:assert/strict"),
  path = require("node:path"),
  fs = require("node:fs"),
  express = require("express");
const { chromium } = require("playwright");
test("one shared screen masks rounded buttons and gaps, follows layout, and releases video", async (t) => {
  const app = express();
  app.use(require("./support/fixture-http-limit.cjs")());
  app.use(express.static(path.resolve(__dirname, "../public/core")));
  app.get("/api/control-deck/media/:id", (_req, res) =>
    res
      .type("video/mp4")
      .send(fs.readFileSync(path.resolve(__dirname, "../public/core/wake-media/silent.mp4"))),
  );
  app.get("/fixture", (_req, res) =>
    res.type("html").send(`<!doctype html>
    <link rel="stylesheet" href="/control-deck.css"><style>
    :root{--bg:#000;--edge:#293449;--deck-color:#333;--deck-radius:30px}
    body{margin:0;background:#000}.controlDeck{width:600px;height:450px;padding:20px;box-sizing:border-box}
    .deckGrid{display:flex!important;margin:0!important;padding:20px!important;gap:30px!important}
    .deckButton{width:180px!important;height:180px!important;flex:none}
    </style><section class="controlDeck"><div class="deckGrid">
    <button class="deckButton" data-deck-button="one">One</button>
    <button class="deckButton" data-deck-button="two">Two</button></div></section>
    <script type="module">import {createDeckScreen} from '/control-deck-screen.js';
    window.screenControl=createDeckScreen(document.querySelector('.controlDeck'));
    screenControl.update({mediaId:'${"a".repeat(64)}.mp4',brightness:70,fit:'cover'});</script>`),
  );
  const server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    }),
    browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const page = await browser.newPage(),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/fixture`);
  await page.waitForFunction(
    () => document.querySelector(".deckScreenMedia video")?.readyState >= 2,
  );
  const mask = await page.locator(".deckScreenMedia").evaluate((layer) => {
    const svg = new DOMParser().parseFromString(
      atob(layer.style.maskImage.split("base64,")[1].split('"')[0]),
      "image/svg+xml",
    );
    return [...svg.querySelectorAll("rect")].map((r) =>
      Object.fromEntries(
        ["x", "y", "width", "height", "rx"].map((k) => [k, Number(r.getAttribute(k))]),
      ),
    );
  });
  assert.equal(mask.length, 2);
  assert.equal(mask[1].x - mask[0].x - mask[0].width, 30, "gap is excluded from the mask");
  assert.equal(mask[0].rx, 30);
  assert.equal(await page.locator("video").count(), 1, "one decoder serves every tile");
  assert.equal(
    await page.locator("video").evaluate((v) => v.muted && v.loop && v.playsInline),
    true,
  );
  await page.locator('[data-deck-button="two"]').evaluate((tile) => (tile.hidden = true));
  await page.waitForFunction(
    () =>
      atob(
        document
          .querySelector(".deckScreenMedia")
          .style.maskImage.split("base64,")[1]
          .split('"')[0],
      ).match(/<rect /g)?.length === 1,
  );
  await page.evaluate(() => screenControl.update(null));
  assert.equal(await page.locator(".deckScreenMedia video").count(), 0);
  assert.equal(await page.locator(".deckScreenMedia").isHidden(), true);
  assert.deepEqual(errors, []);
});
