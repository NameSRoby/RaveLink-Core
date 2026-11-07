const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const load = import(
  "data:text/javascript;base64," +
    Buffer.from(
      fs
        .readFileSync(path.join(__dirname, "../public/core/control-deck-awake.js"), "utf8")
        .replace(
          "new URL(`./wake-media/silent.${type}`, import.meta.url).href",
          "`http://lan/core/wake-media/silent.${type}`",
        ),
    ).toString("base64")
);
// Buffer encoding is explicit: the module under test contains import.meta asset URLs.
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
function setup(request) {
  const doc = new EventTarget(),
    view = new EventTarget(),
    states = [],
    videos = [];
  doc.visibilityState = "visible";
  doc.defaultView = view;
  doc.body = { append() {} };
  doc.createElement = (tag) => {
    const element = new EventTarget();
    Object.assign(element, {
      style: {},
      setAttribute() {},
      append() {},
      play: async () => {
        element.playing = true;
      },
      pause() {
        element.playing = false;
      },
    });
    if (tag === "video") videos.push(element);
    return element;
  };
  return {
    doc,
    view,
    states,
    videos,
    options: {
      document: doc,
      navigator: request ? { wakeLock: { request } } : {},
      onState: (state) => states.push(state),
    },
  };
}
function sentinel() {
  const lock = new EventTarget();
  lock.releases = 0;
  lock.release = async () => {
    lock.releases++;
    lock.dispatchEvent(new Event("release"));
  };
  return lock;
}
test("fullscreen screen lock releases on background, reacquires on return, and honors opt-out", async () => {
  const { createDeckAwake } = await load,
    locks = [];
  const env = setup(async (type) => {
    assert.equal(type, "screen");
    const lock = sentinel();
    locks.push(lock);
    return lock;
  });
  const awake = createDeckAwake(env.options);
  awake.enter();
  await settle();
  assert.equal(locks.length, 1);
  assert.equal(env.states.at(-1), "active");
  env.doc.visibilityState = "hidden";
  env.doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(locks[0].releases, 1);
  env.doc.visibilityState = "visible";
  env.doc.dispatchEvent(new Event("visibilitychange"));
  await settle();
  assert.equal(locks.length, 2);
  awake.toggle();
  assert.equal(locks[1].releases, 1);
  assert.equal(env.states.at(-1), "off");
  awake.enter();
  await settle();
  assert.equal(locks.length, 2);
  awake.toggle();
  await settle();
  assert.equal(locks.length, 3);
  awake.leave();
  assert.equal(locks[2].releases, 1);
});
test("a pending request cannot leak a lock after exit and does not duplicate concurrent requests", async () => {
  const { createDeckAwake } = await load,
    pending = deferred(),
    lock = sentinel();
  let calls = 0;
  const env = setup(() => {
      calls++;
      return pending.promise;
    }),
    awake = createDeckAwake(env.options);
  awake.enter();
  awake.enter();
  assert.equal(calls, 1);
  awake.leave();
  pending.resolve(lock);
  await settle();
  assert.equal(lock.releases, 1);
  assert.notEqual(env.states.at(-1), "active");
});
test("OS refusal and revocation are reported without an endless retry loop", async () => {
  const { createDeckAwake } = await load;
  let calls = 0;
  const lock = sentinel(),
    env = setup(async () => {
      if (++calls === 1) throw new Error("denied");
      return lock;
    });
  const awake = createDeckAwake(env.options);
  awake.enter();
  await settle();
  assert.equal(env.states.at(-1), "blocked");
  assert.equal(calls, 1);
  awake.retry();
  await settle();
  assert.equal(env.states.at(-1), "active");
  lock.dispatchEvent(new Event("release"));
  assert.equal(env.states.at(-1), "blocked");
  assert.equal(calls, 2);
  awake.leave();
});
test("HTTP LAN fallback starts on entry only and pauses on background, exit and pagehide", async () => {
  const { createDeckAwake } = await load,
    env = setup(),
    awake = createDeckAwake(env.options);
  assert.equal(env.videos.length, 0);
  awake.enter();
  await settle();
  assert.equal(env.states.at(-1), "fallback");
  assert.equal(env.videos[0].playing, true);
  env.doc.visibilityState = "hidden";
  env.doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(env.videos[0].playing, false);
  env.doc.visibilityState = "visible";
  env.doc.dispatchEvent(new Event("visibilitychange"));
  await settle();
  assert.equal(env.videos.length, 1);
  assert.equal(env.videos[0].playing, true);
  env.view.dispatchEvent(new Event("pagehide"));
  assert.equal(env.videos[0].playing, false);
  env.doc.dispatchEvent(new Event("visibilitychange"));
  await settle();
  assert.equal(env.videos[0].playing, false);
});

test("mobile fullscreen loads bundled compatibility media and stops playback on exit", async (t) => {
  const express = require("express"),
    { chromium } = require("playwright");
  const app = express();
  app.use(require("./support/fixture-http-limit.cjs")());
  app.use(express.static(path.resolve(__dirname, "../public/core")));
  app.get("/awake-fixture", (_req, res) =>
    res.type("html").send(`<!doctype html>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <button id="enter">Fullscreen</button><section id="deck"></section>
    <script type="module">
      import {createDeckFullscreen} from '/control-deck-fullscreen.js';
      Object.defineProperty(navigator, 'wakeLock', {value:undefined});
      const host=document.getElementById('deck');
      host.requestFullscreen=undefined;
      createDeckFullscreen({host,button:document.getElementById('enter'),onEnter(){}});
    </script>`),
  );
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  let browser;
  t.after(async () => {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/awake-fixture`);
  await page.waitForFunction(() => document.getElementById("deckKeepAwake"));
  await page.locator("#enter").tap();
  await page.waitForFunction(
    () => document.getElementById("deckKeepAwake").dataset.state === "fallback",
  );
  assert.equal(
    await page.locator("video").evaluate((el) => !el.paused && el.readyState >= 2),
    true,
  );
  assert.equal(
    await page.locator("video").evaluate((el) => el.currentSrc.startsWith(location.origin)),
    true,
  );
  await page.locator("#deckKeepAwake").tap();
  assert.equal(await page.locator("video").evaluate((el) => el.paused), true);
  await page.locator("#deckKeepAwake").tap();
  await page.waitForFunction(() => !document.querySelector("video").paused);
  await page.locator("#deckExitFullscreen").tap();
  assert.equal(await page.locator("video").evaluate((el) => el.paused), true);
  assert.equal(await page.getByRole("switch", { name: "Keep screen awake" }).isChecked(), true);
  assert.equal(await page.locator("#deckKeepAwake").isVisible(), true);
  assert.deepEqual(errors, []);
});
