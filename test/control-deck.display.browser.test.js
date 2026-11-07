/** Production display fitting and CSS, with inert synthetic buttons only. */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const express = require("express");
const { chromium } = require("playwright");

const fullTitle = "Start the next saved lighting look and keep the current music playing";
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/core.css"><link rel="stylesheet" href="/control-deck.css"><link rel="stylesheet" href="/app-polish.css"><style>
#fixture{width:1080px;max-width:100%;--deck-columns:3;--deck-tablet-columns:3;--deck-phone-columns:3;--deck-label-scale:1;--deck-color:#a90036;--deck-text:#fff;--deck-backlight:.65;--deck-master-backlight:1}
</style></head><body><main id="fixture" class="controlDeck" data-display="per-button"><div class="deckGrid">
<button class="deckButton" data-deck-button="auto" data-text-mode="auto" aria-label="${fullTitle}"><span class="deckButtonSymbol" aria-hidden="true">♫</span><span class="deckButtonTitle">${fullTitle}</span><span class="deckButtonState">Confirmed playing</span></button>
<button class="deckButton" data-deck-button="image" data-text-mode="image" aria-label="Only the icon is visible"><span class="deckButtonSymbol" aria-hidden="true">♫</span><span class="deckButtonTitle">Only the icon is visible</span></button>
<button class="deckButton" data-deck-button="text" data-text-mode="text" aria-label="Only the text is visible"><span class="deckButtonSymbol" aria-hidden="true">♫</span><span class="deckButtonTitle">Only the text is visible</span></button>
<button class="deckButton" data-deck-button="alternate" data-text-mode="alternate" aria-label="Alternate icon and full text"><span class="deckButtonSymbol" aria-hidden="true">♫</span><span class="deckButtonTitle">Alternate icon and full text</span></button>
<div class="deckButton" data-deck-button="volume" data-text-mode="alternate" role="group" aria-label="Player volume"><span class="deckButtonSymbol" aria-hidden="true">◕</span><span class="deckButtonTitle">Player volume</span><input class="deckVolumeSlider" type="range" min="0" max="100" value="50" aria-label="Player volume"><output class="deckSliderValue">50%</output><span class="deckButtonState">Confirmed level</span></div>
</div></main><script type="module">
import {createDeckDisplay} from '/control-deck-display.js';
window.display=createDeckDisplay(document.getElementById('fixture'));
window.scheduleCalls=0;
window.pollDisplay=()=>{window.scheduleCalls++;window.display.schedule()};
document.querySelector('.deckVolumeSlider').addEventListener('input',event=>document.querySelector('.deckSliderValue').textContent=event.target.value+'%');
window.display.schedule();
</script></body></html>`;

async function fixture(t, options = {}) {
  const app = express();
  app.use(require("./support/fixture-http-limit.cjs")());
  for (const file of ["core.css", "control-deck.css", "app-polish.css", "control-deck-display.js"])
    app.get("/" + file, (_req, res) =>
      res.sendFile(path.resolve(__dirname, "../public/core", file)),
    );
  app.get("/", (_req, res) => res.type("html").send(html));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, ...options });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.goto("http://127.0.0.1:" + server.address().port);
  await page.waitForFunction(
    () => document.querySelector('[data-deck-button="auto"]').dataset.displayMode,
  );
  return page;
}

test("deck display fits crowded buttons, honors explicit modes and observes resizing", async (t) => {
  const page = await fixture(t),
    auto = page.locator('[data-deck-button="auto"]');
  assert.equal(await auto.getAttribute("data-display-mode"), "image-text");
  assert.equal(
    await page.locator('[data-deck-button="image"]').getAttribute("data-display-mode"),
    "image",
  );
  assert.equal(
    await page.locator('[data-deck-button="text"]').getAttribute("data-display-mode"),
    "text",
  );
  assert.equal(
    await page.locator('[data-deck-button="alternate"]').getAttribute("data-display-mode"),
    "alternate",
  );
  assert.equal(
    await page.locator('[data-deck-button="text"] .deckButtonSymbol').isVisible(),
    false,
  );
  assert.equal(
    await page
      .locator('[data-deck-button="image"] .deckButtonTitle')
      .evaluate((el) => getComputedStyle(el).clipPath),
    "inset(50%)",
  );
  await page.locator("#fixture").evaluate((el) => (el.style.width = "360px"));
  await page.waitForFunction(
    () => document.querySelector('[data-deck-button="auto"]').dataset.displayMode === "alternate",
  );
  assert.equal(
    await auto.getAttribute("aria-label"),
    fullTitle,
    "automatic fitting preserves the complete accessible name",
  );
  assert.equal(await auto.locator(".deckButtonTitle").textContent(), fullTitle);
  await page.locator("#fixture").evaluate((el) => (el.style.width = "1080px"));
  await page.waitForFunction(
    () => document.querySelector('[data-deck-button="auto"]').dataset.displayMode === "image-text",
  );
  await page.locator("#fixture").evaluate((el) => (el.dataset.display = "text"));
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".deckButton:not(:has(.deckVolumeSlider))")].every(
      (el) => el.dataset.displayMode === "text",
    ),
  );
  assert.equal(await auto.getAttribute("aria-label"), fullTitle);
});

test("eight-second icon/text cycle survives regular status fitting requests", async (t) => {
  const page = await fixture(t),
    tile = page.locator('[data-deck-button="alternate"]');
  await page.waitForFunction(() =>
    Number.isFinite(
      document.querySelector('[data-deck-button="alternate"] .deckButtonSymbol').getAnimations()[0]
        ?.startTime,
    ),
  );
  const start = await tile.evaluate((el) => {
    const icon = el.querySelector(".deckButtonSymbol"),
      title = el.querySelector(".deckButtonTitle");
    window.pollTimer = setInterval(window.pollDisplay, 1500);
    return {
      duration: getComputedStyle(icon).animationDuration,
      icon: getComputedStyle(icon).opacity,
      text: getComputedStyle(title).opacity,
      startTime: icon.getAnimations()[0].startTime,
    };
  });
  assert.equal(start.duration, "8s");
  assert.equal(start.icon, "1");
  assert.equal(start.text, "0");
  await page.waitForFunction(
    () => {
      const tile = document.querySelector('[data-deck-button="alternate"]');
      return (
        getComputedStyle(tile.querySelector(".deckButtonSymbol")).opacity === "0" &&
        getComputedStyle(tile.querySelector(".deckButtonTitle")).opacity === "1"
      );
    },
    null,
    { timeout: 5500 },
  );
  assert.ok((await page.evaluate(() => window.scheduleCalls)) >= 2);
  assert.equal(
    await tile.locator(".deckButtonSymbol").evaluate((el) => el.getAnimations()[0].startTime),
    start.startTime,
    "status refresh must not restart the display animation",
  );
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector('[data-deck-button="alternate"] .deckButtonSymbol'))
        .opacity === "1",
    null,
    { timeout: 5000 },
  );
  assert.ok((await page.evaluate(() => window.scheduleCalls)) >= 5);
  assert.equal(await tile.getAttribute("aria-label"), "Alternate icon and full text");
  await page.evaluate(() => clearInterval(window.pollTimer));
});

test("reduced motion keeps text readable and a narrow volume slider remains operable", async (t) => {
  const page = await fixture(t, {
    reducedMotion: "reduce",
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  const text = page.locator('[data-deck-button="alternate"] .deckButtonTitle');
  const motion = await text.evaluate((el) => ({
    opacity: getComputedStyle(el).opacity,
    animations: el.getAnimations().length,
  }));
  assert.equal(
    motion.opacity,
    "1",
    "reduced-motion users must see the title without waiting for a cycle",
  );
  assert.equal(motion.animations, 0);
  const volume = page.locator('[data-deck-button="volume"]'),
    slider = volume.locator(".deckVolumeSlider");
  assert.equal(
    await volume.getAttribute("data-display-mode"),
    "image-text",
    "a value control never alternates away its input",
  );
  assert.equal(await volume.getAttribute("data-compact"), "true");
  const tileBox = await volume.boundingBox(),
    inputBox = await slider.boundingBox();
  assert.ok(
    inputBox.width >= 36 && inputBox.height >= 28,
    "compact slider keeps an operable pointer target: " + JSON.stringify({ tileBox, inputBox }),
  );
  assert.ok(
    inputBox.x >= tileBox.x && inputBox.x + inputBox.width <= tileBox.x + tileBox.width + 1,
  );
  await slider.focus();
  await page.keyboard.press("End");
  assert.equal(await slider.inputValue(), "100");
  await page.keyboard.press("Home");
  assert.equal(await slider.inputValue(), "0");
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    "narrow tiles do not force page overflow",
  );
});
