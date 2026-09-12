const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const createCoreServer = require("../src/app/core/create-core-server");

test("widget template generation has independent rate-limited admission", async t => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-template-limit-"));
  const created = createCoreServer({
    runtimeDir,
    dryRun: true,
    widgetIntakeLimiterOptions: { capacity: 1, refillPerSecond: 0.1 }
  });
  const server = await new Promise(resolve => {
    const listener = created.app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  t.after(async () => {
    await created.services.lifecycle.stopAll();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });
  const endpoint = `http://127.0.0.1:${server.address().port}/system/widget-template-get`;
  const request = () => fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseUrl: "http://127.0.0.1:5050" })
  });
  assert.equal((await request()).status, 200);
  const limited = await request();
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "10");
  assert.equal((await limited.json()).error, "widget_template_rate_limited");
});

test("song request player restricts parent messaging to its serving origin", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "features", "song-request", "ui", "player.html"), "utf8");
  assert.match(source, /const PARENT_ORIGIN=location\.origin/);
  assert.match(source, /event\.origin!==PARENT_ORIGIN/);
  assert.doesNotMatch(source, /parent\.postMessage\([^\n]+,"\*"\)/);
});
