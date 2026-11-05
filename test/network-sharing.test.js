const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { chromium } = require("playwright");
const createCoreServer = require("../src/app/core/create-core-server");
const createSharing = require("../src/domains/system/network-sharing.service");
async function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}
async function freePort() {
  const server = await listen(http.createServer());
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function environment(t) {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "rvl-network-test-"));
  const created = createCoreServer({
    runtimeDir,
    dryRun: true,
    fixtureSecretVaultOptions: require("./support/fixture-vault-codec.cjs"),
  });
  const server = await listen(created.app);
  t.after(async () => {
    await created.services.lifecycle.stopAll();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });
  const local = `http://127.0.0.1:${server.address().port}`;
  const configure = async (enabled, port, base = local) =>
    fetch(base + "/api/network-sharing", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ enabled, port }),
    }).then(async (response) => ({ status: response.status, body: await response.json() }));
  return { ...created, server, runtimeDir, local, configure };
}
test("LAN gateway enables full operator controls without changing localhost or accepting hostile origins", async (t) => {
  const e = await environment(t),
    port = await freePort(),
    lan = `http://127.0.0.1:${port}`;
  assert.equal(e.services.networkSharing.snapshot().enabled, false);
  assert.equal((await e.configure(true, port)).body.active, true);
  assert.match(await fetch(lan).then((r) => r.text()), /RaveLink Core/);
  assert.equal((await fetch(lan + "/api/dashboard")).status, 200);
  const theme = { accent: "#2474bf", bg: "#050507", surface: "#121a2f", text: "#eaeaea", glow: 65 };
  const write = (origin) =>
    fetch(lan + "/api/presentation/theme", {
      method: "PUT",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ theme }),
    });
  assert.equal((await write("https://evil.example")).status, 403);
  assert.equal((await write("null")).status, 403);
  const forgedHostStatus = await new Promise((resolve, reject) => {
    const request = http.get(lan, { headers: { Host: `evil.example:${port}` } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on("error", reject);
  });
  assert.equal(forgedHostStatus, 403);
  assert.equal((await write(lan)).status, 200);
  assert.equal(
    (await fetch(e.local + "/api/presentation/theme").then((r) => r.json())).theme.accent,
    theme.accent,
  );
  const occupied = await new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, "0.0.0.0", () => resolve(server));
  });
  t.after(() => new Promise((resolve) => occupied.close(resolve)));
  assert.equal((await e.configure(true, occupied.address().port)).status, 409);
  assert.equal(e.services.networkSharing.snapshot().port, port);
  assert.equal((await fetch(lan + "/api/dashboard")).status, 200);
  assert.equal((await e.configure(false, port, lan)).body.active, false);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await assert.rejects(fetch(lan));
  assert.equal((await fetch(e.local + "/health")).status, 200);
});
test("saved sharing restores on activation and shutdown drains streaming proxy connections", async (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "rvl-lan-stream-"));
  let headers;
  const backend = await listen(
    http.createServer((req, res) => {
      headers = req.headers;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: ready\n\n");
    }),
  );
  t.after(async () => {
    await new Promise((resolve) => backend.close(resolve));
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });
  const options = { runtimeDir, corePort: backend.address().port };
  const first = createSharing(options),
    port = await freePort();
  await first.configure({ enabled: true, port });
  await first.stop();
  const restored = createSharing(options);
  t.after(() => restored.stop());
  assert.equal(restored.snapshot().active, false);
  await restored.activate();
  const response = await fetch(`http://127.0.0.1:${port}/stream`, {
    headers: { "X-Forwarded-For": "127.0.0.1", Forwarded: "for=trusted" },
  });
  const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /ready/);
  assert.equal(headers["x-forwarded-for"], undefined);
  assert.equal(headers.forwarded, undefined);
  await restored.stop();
  await reader.cancel().catch(() => {});
});
test("private network admission excludes public addresses", () => {
  for (const address of [
    "192.168.1.2",
    "10.0.0.3",
    "172.16.0.4",
    "169.254.1.2",
    "::ffff:192.168.0.8",
  ])
    assert.equal(createSharing.privateAddress(address), true);
  for (const address of [
    "8.8.8.8",
    "172.32.0.1",
    "1.1.1.1",
    "192.168.0.999",
    "garbage",
    "192.168..1",
    "192.168.01.1",
    "10. 0.0.1",
  ])
    assert.equal(createSharing.privateAddress(address), false);
});

test("an interrupted LAN upload leaves the gateway available for the next request", async (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "rvl-lan-abort-"));
  let reached;
  const receiving = new Promise((resolve) => {
    reached = resolve;
  });
  const backend = await listen(
    http.createServer((req, res) => {
      req.on("error", () => {});
      if (req.method === "POST") req.once("data", reached);
      else res.end("ready");
    }),
  );
  const sharing = createSharing({ runtimeDir, corePort: backend.address().port });
  t.after(async () => {
    await sharing.stop();
    await new Promise((resolve) => backend.close(resolve));
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });
  const port = await freePort();
  await sharing.configure({ enabled: true, port });
  const request = http.request(`http://127.0.0.1:${port}/upload`, {
    method: "POST",
    headers: { "Content-Length": "100000" },
  });
  request.on("error", () => {});
  request.write("partial");
  await receiving;
  request.destroy();
  assert.equal(await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.text()), "ready");
});
test("LAN browser edits the same Core settings and exposes sharing addresses on phone and desktop", async (t) => {
  const e = await environment(t),
    port = await freePort();
  await e.configure(true, port);
  const urls = e.services.networkSharing.snapshot().urls;
  const base = urls[0]?.replace(/\/$/, "") || `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  for (const viewport of [
    { width: 1366, height: 900 },
    { width: 390, height: 844 },
  ]) {
    const page = await browser.newPage({ viewport }),
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base, { waitUntil: "networkidle" });
    assert.equal(await page.locator("#networkShareButton svg").count(), 1);
    assert.equal((await page.locator("#networkShareButton").textContent()).trim(), "");
    assert.deepEqual(
      await page.locator("#networkShareButton").evaluate((el) => {
        const r = el.getBoundingClientRect();
        return [r.width, r.height];
      }),
      [36, 36],
    );
    await page.locator("#networkShareButton").click();
    await page.waitForFunction(() =>
      document.getElementById("lanStatus").textContent.includes("Sharing is on"),
    );
    assert.equal(await page.locator("#lanEnabled").isChecked(), true);
    assert.deepEqual(
      await page.locator("#lanEnabled").evaluate((el) => {
        const r = el.getBoundingClientRect(),
          ball = getComputedStyle(el, "::before");
        return [r.width, r.height, ball.width, ball.height, ball.top];
      }),
      [38, 22, "16px", "16px", "2px"],
    );
    await page.locator("#closeNetworkSharing").click();
    await page.locator("#themeButton").click();
    await page.locator("#themeAccent").fill("#2474bf");
    await page.waitForFunction(
      () =>
        getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() ===
        "#2474bf",
    );
    assert.equal(await page.evaluate(() => typeof navigator.clipboard.writeText), "function");
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      true,
    );
    assert.deepEqual(errors, []);
    await page.locator("#closeTheme").click();
    await page.screenshot({
      path: path.join(__dirname, "../runtime/app-polish-" + viewport.width + ".png"),
      fullPage: true,
    });
    await page.close();
  }
});
