const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const createCoreServer = require("../src/app/core/create-core-server");

test("widget template generation has independent rate-limited admission", async (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-template-limit-"));
  const created = createCoreServer({
    runtimeDir,
    dryRun: true,
    widgetIntakeLimiterOptions: { capacity: 1, refillPerSecond: 0.1 },
  });
  const server = await new Promise((resolve) => {
    const listener = created.app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  t.after(async () => {
    await created.services.lifecycle.stopAll();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });
  const endpoint = `http://127.0.0.1:${server.address().port}/system/widget-template-get`;
  const request = () =>
    fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: "http://127.0.0.1:5050" }),
    });
  assert.equal((await request()).status, 200);
  const limited = await request();
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "10");
  assert.equal((await limited.json()).error, "widget_template_rate_limited");
});

test("song request player restricts parent messaging to its serving origin", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "features", "song-request", "ui", "player.html"),
    "utf8",
  );
  assert.match(source, /const PARENT_ORIGIN\s*=\s*location\.origin/);
  assert.match(source, /event\.origin\s*!==\s*PARENT_ORIGIN/);
  assert.doesNotMatch(source, /parent\.postMessage\([\s\S]*?,\s*"\*"\s*\)/);
});

test("invalid widget credentials are rate-limited before template authorization", async (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-template-auth-limit-"));
  const created = createCoreServer({ runtimeDir, dryRun: true });
  assert.equal(created.services.widgetTokenVault.rotate().ok, true);
  const server = await new Promise((resolve) => {
    const listener = created.app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  t.after(async () => {
    await created.services.lifecycle.stopAll();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });
  const endpoint = `http://127.0.0.1:${server.address().port}/system/widget-template-get`;
  for (let index = 0; index < 121; index++) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ widgetIntakeToken: "invalid" }),
    });
    await response.arrayBuffer();
    assert.equal(response.status, index < 120 ? 401 : 429);
    if (index === 120) assert.ok(Number(response.headers.get("retry-after")) > 0);
  }
});
