const test = require("node:test"),
  assert = require("node:assert/strict"),
  path = require("node:path"),
  express = require("express");
const { chromium } = require("playwright");
test("optional slider increments support keyboard, endpoints and per-button overrides without changing external state", async (t) => {
  const app = express();
  app.use(require("./support/fixture-http-limit.cjs")());
  app.use(express.static(path.resolve(__dirname, "../public/core")));
  app.get("/fixture", (_req, res) =>
    res.type("html")
      .send(`<!doctype html><input type="range" min="0" max="100" step="1" value="54" aria-label="Volume"><output></output>
 <script type="module">import {bindDeckSlider,sliderIncrement} from '/control-deck-slider.js';
 window.writes=[];const input=document.querySelector('input');input.dataset.increment=sliderIncrement({sliderSnap:true,sliderIncrement:7});
 window.control=bindDeckSlider({input,output:document.querySelector('output'),send:async value=>{writes.push(value);}});
 window.overrides=[sliderIncrement({sliderSnap:true,sliderIncrement:7},{sliderSnap:'off'}),sliderIncrement({sliderSnap:false},{sliderSnap:'on',sliderIncrement:10})];window.ready=true;</script>`),
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
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/fixture`);
  await page.waitForFunction(() => window.ready);
  const slider = page.getByRole("slider", { name: "Volume" });
  assert.equal(await slider.inputValue(), "54", "enabling snap never changes the current volume");
  assert.deepEqual(await page.evaluate(() => overrides), [1, 10]);
  await slider.fill("19");
  assert.equal(await slider.inputValue(), "21");
  await page.waitForFunction(() => writes.includes(21));
  await slider.press("End");
  assert.equal(
    await slider.inputValue(),
    "100",
    "non-divisor increments retain the upper endpoint",
  );
  await slider.press("ArrowLeft");
  assert.equal(await slider.inputValue(), "98");
  await slider.press("ArrowRight");
  assert.equal(await slider.inputValue(), "100");
  await slider.press("Home");
  assert.equal(await slider.inputValue(), "0");
  await page.waitForFunction(() => writes.at(-1) === 0);
  await page.waitForTimeout(1850);
  await page.evaluate(() => control.sync(54));
  assert.equal(
    await slider.inputValue(),
    "54",
    "confirmed external values stay honest rather than snapping the device",
  );
  await page.locator("output").click();
  const exact = page.getByRole("spinbutton", { name: "Volume exact percent" });
  await exact.fill("35");
  await exact.press("Enter");
  await page.waitForFunction(() => writes.at(-1) === 35);
  assert.equal(await slider.inputValue(), "35");
  const count = await page.evaluate(() => writes.length);
  await slider.dispatchEvent("change");
  await page.waitForTimeout(180);
  assert.equal(
    await page.evaluate(() => writes.length),
    count,
    "release/change cannot repeat an unchanged write",
  );
});
