const test = require("node:test"),
  assert = require("node:assert/strict");
const express = require("express"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const theme = {
  accent: "#123456",
  bg: "#010203",
  surface: "#334455",
  text: "#ffeedd",
  glow: 10,
};
for (const [name, body, filename] of [
  ["theme", { theme }, "presentation-theme.json"],
  ["navigation", { tabs: { widget: "hidden" } }, "navigation.json"],
]) {
  test(name + " limits writes, skips unchanged saves and leaves reads available", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-save-limit-"));
    const app = express();
    app.use(express.json());
    require(
      "../src/app/core/register-" + (name === "theme" ? "presentation" : "navigation") + ".routes",
    )(app, { runtimeDir: root, rateLimitOptions: { limit: 2 } });
    const server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    t.after(async () => {
      await new Promise((r) => server.close(r));
      fs.rmSync(root, { recursive: true, force: true });
    });
    const url = "http://127.0.0.1:" + server.address().port + "/api/presentation/" + name;
    const put = (value, origin) =>
      fetch(url, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          ...(origin ? { origin } : {}),
        },
        body: JSON.stringify(value),
      });
    assert.equal((await put(body, "https://foreign.invalid")).status, 403);
    assert.equal((await put(body)).status, 200);
    const file = path.join(root, "system", filename);
    // A deliberately old timestamp makes an unnecessary rewrite observable.
    fs.utimesSync(file, new Date(1000), new Date(1000));
    assert.equal((await put(body)).status, 200);
    assert.equal(fs.statSync(file).mtimeMs, 1000);
    const limited = await put(
      name === "theme" ? { theme: { ...theme, glow: 20 } } : { tabs: { widget: "main" } },
    );
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
    const read = await fetch(url);
    assert.equal(read.status, 200);
    const saved = await read.json();
    assert.equal(
      name === "theme" ? saved.theme.glow : saved.tabs.widget,
      name === "theme" ? 10 : "hidden",
    );
  });
}

test("Spotify bridge rate limits authorization attempts while preserving origin checks and preflights", async (t) => {
  const host = require("../integrations/spotify-desktop/host-bridge.cjs")({
    rateLimitOptions: { limit: 3 },
  });
  const app = express();
  app.use("/bridge", host.router());
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  t.after(async () => {
    host.close();
    await new Promise((r) => server.close(r));
  });
  const url = "http://127.0.0.1:" + server.address().port + "/bridge/hello";
  const request = (token, origin) =>
    fetch(url, {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
        ...(origin ? { origin } : {}),
      },
      body: JSON.stringify({ clientId: "client" }),
    });
  assert.equal((await request("bad", "https://foreign.invalid")).status, 403);
  assert.equal(
    (
      await fetch(url, {
        method: "OPTIONS",
        headers: { origin: "https://xpui.app.spotify.com" },
      })
    ).status,
    204,
  );
  assert.equal((await request("bad")).status, 401);
  assert.equal((await request(host.pairing().token)).status, 200);
  assert.equal((await request(host.pairing().token)).status, 200);
  const limited = await request(host.pairing().token);
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error, "spotify_bridge_rate_limited");
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
});

test("theme autosave honors Retry-After and sends the latest edit when the limit resets", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0,
    failures = 0;
  const calls = [],
    window = {};
  require("node:vm").runInNewContext(
    fs.readFileSync(path.join(__dirname, "../public/core/theme-state.js"), "utf8"),
    {
      window,
      setTimeout,
      clearTimeout,
      Date: { now: () => now },
      fetch: async (_url, input) => {
        calls.push(JSON.parse(input.body).theme);
        return calls.length === 1
          ? { ok: false, status: 429, headers: { get: () => "2" } }
          : { ok: true, status: 200 };
      },
    },
  );
  const save = window.createSharedThemeSaver(() => {
    failures++;
  });
  save({ glow: 1 });
  now = 250;
  t.mock.timers.tick(250);
  await new Promise((r) => setImmediate(r));
  save({ glow: 2 });
  now = 500;
  t.mock.timers.tick(250);
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 1);
  now = 2250;
  t.mock.timers.tick(1750);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ glow: 1 }, { glow: 2 }]);
  assert.equal(failures, 0);
});
