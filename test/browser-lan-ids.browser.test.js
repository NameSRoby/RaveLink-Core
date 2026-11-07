/** Exercise the actual browser pages on an insecure HTTP origin, without providers. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, "..");
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
test("plain HTTP browser controls and sandboxed Song Request work without randomUUID", async (t) => {
  const app = express(),
    commands = [];
  app.use(require("./support/fixture-http-limit.cjs")());
  app.use(express.json());
  for (const [url, file] of [
    ["/browser-random-id.js", "public/core/browser-random-id.js"],
    ["/control-deck-id.js", "public/core/control-deck-id.js"],
    ["/dashboard.js", "integrations/youtube-browser/dashboard/dashboard.js"],
    ["/style.css", "integrations/youtube-browser/dashboard/style.css"],
  ])
    app.get(url, (_req, res) => res.sendFile(path.join(root, file)));
  app.get("/console", (_req, res) =>
    res.sendFile(path.join(root, "integrations/youtube-browser/dashboard/index.html")),
  );
  app.get("/api/status", (_req, res) =>
    res.json({
      fresh: true,
      connected: true,
      snapshot: {
        current: { videoId: "aaaaaaaaaaa", title: "LAN fixture", artist: "Fixture" },
        controls: true,
        paused: false,
        nextAvailable: true,
        position: 1,
        duration: 180,
        queue: [],
      },
    }),
  );
  app.post("/api/control", (req, res) => {
    commands.push(req.body);
    res.json({ ok: true });
  });
  app.get("/player", (_req, res) =>
    res
      .setHeader(
        "Content-Security-Policy",
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'",
      )
      .type("html")
      .send(fs.readFileSync(path.join(root, "features/song-request/ui/player.html"), "utf8")),
  );
  app.get("/", (_req, res) =>
    res.type("html").send(`<!doctype html><html><body>
<iframe id="player" src="/player" sandbox="allow-scripts" style="width:100%;height:900px"></iframe>
<script>
window.playerCalls=[];
addEventListener('message',event=>{
 const frame=document.querySelector('#player'); const message=event.data;
 if(event.source!==frame.contentWindow||message?.channel!=='ravelink-feature-ui-v1'||message.type!=='call')return;
 playerCalls.push(message);
 let value;
 if(message.capability==='song.player.preferences.v1')value={ok:true,player:'youtube',youtubePlayback:'embed'};
 if(message.capability==='song.queue.submit.v1')value={ok:true,entry:{candidate:message.payload.candidate}};
 if(value)frame.contentWindow.postMessage({channel:message.channel,type:'response',id:message.id,ok:true,value},'*');
});
</script><script type="module">import {deckId} from '/control-deck-id.js';window.moduleId=deckId();</script>
</body></html>`),
  );
  const server = await new Promise((resolve) => {
    const value = app.listen(0, "127.0.0.1", () => resolve(value));
  });
  const browser = await chromium.launch({
    headless: true,
    args: ["--host-resolver-rules=MAP ravelink-lan.test 127.0.0.1", "--no-proxy-server"],
  });
  t.after(async () => {
    await browser.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const page = await browser.newPage(),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const base = `http://ravelink-lan.test:${server.address().port}`;
  await page.goto(base, { waitUntil: "domcontentloaded" });
  assert.equal(await page.evaluate(() => isSecureContext), false);
  assert.equal(await page.evaluate(() => typeof crypto.randomUUID), "undefined");
  await page.waitForFunction(() => typeof moduleId === "string");
  assert.match(await page.evaluate(() => moduleId), /^deck-[a-f0-9-]{36}$/);
  const player = page.locator("#player").contentFrame();
  await player.locator("#startPlayer").waitFor();
  assert.equal(await player.locator("body").evaluate(() => isSecureContext), false);
  assert.equal(await player.locator("body").evaluate(() => typeof crypto.randomUUID), "undefined");
  const generated = await player
    .locator("body")
    .evaluate(() => Array.from({ length: 64 }, () => RaveLinkRandomId()));
  assert.equal(new Set(generated).size, 64);
  generated.forEach((value) => assert.match(value, uuid));
  await player.locator("#videoInput").fill("aaaaaaaaaaa");
  await player.locator("#addSong").click();
  await page.waitForFunction(() =>
    playerCalls.some((call) => call.capability === "song.queue.submit.v1"),
  );
  assert.match(
    await page.evaluate(
      () =>
        playerCalls.find((call) => call.capability === "song.queue.submit.v1").payload.requestId,
    ),
    uuid,
  );
  await page.goto(base + "/console");
  await page.locator('[data-action="pause"]').click();
  await page.getByText("Confirmed by the player.", { exact: true }).waitFor();
  assert.equal(commands.length, 1);
  assert.match(commands[0].id, uuid);
  assert.equal(commands[0].action, "pause");
  assert.deepEqual(errors, []);
});
