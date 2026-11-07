const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const createCore = require("../src/app/core/create-core-server");
test("deck HTTP validates saved actions, origins and media without desktop side effects on read", async (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-deck-http-"));
  let executions = 0;
  const desktopActions = {
    catalog: () => [
      {
        id: "native.test",
        label: "Test",
        symbol: "✦",
        available: true,
        parameters: { type: "object", additionalProperties: false, properties: {} },
      },
    ],
    execute: async () => {
      executions++;
      return { ok: true };
    },
    integrations: async () => ({ discord: { available: false, muted: null } }),
    shutdown() {},
  };
  const core = createCore({ runtimeDir, dryRun: true, desktopActions });
  const server = await new Promise((resolve) => {
    const s = core.app.listen(0, "127.0.0.1", () => resolve(s));
  });
  t.after(async () => {
    await core.services.lifecycle.stopAll();
    await new Promise((r) => server.close(r));
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });
  const base = "http://127.0.0.1:" + server.address().port;
  const request = (url, method = "GET", payload, origin) =>
    fetch(base + url, {
      method,
      headers: {
        ...(payload ? { "content-type": "application/json" } : {}),
        ...(origin ? { Origin: origin } : {}),
      },
      body: payload ? JSON.stringify(payload) : undefined,
    });
  const first = await (await request("/api/control-deck")).json();
  assert.equal(first.ok, true);
  assert.equal(executions, 0);
  const config = {
    version: 1,
    mode: "deck",
    columns: 4,
    pages: [
      {
        id: "main",
        name: "Main",
        buttons: [
          {
            id: "test",
            title: "Test",
            kind: "macro",
            steps: [{ actionId: "native.test", params: {} }],
          },
        ],
      },
    ],
  };
  assert.equal(
    (
      await request(
        "/api/control-deck",
        "PUT",
        { revision: first.value.revision, value: config },
        "https://untrusted.example",
      )
    ).status,
    403,
  );
  assert.equal(
    (await request("/api/control-deck", "PUT", { revision: first.value.revision, value: config }))
      .status,
    200,
  );
  assert.equal(executions, 0, "editing never executes a button");
  assert.equal(
    (
      await request("/api/control-deck/buttons/test/execute", "POST", {
        trigger: "press",
        actionId: "native.open",
      })
    ).status,
    400,
  );
  assert.equal(
    (await request("/api/control-deck/buttons/test/execute", "POST", { trigger: "press" })).status,
    200,
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(executions, 1);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
    "base64",
  );
  const uploaded = await (
    await fetch(base + "/api/control-deck/media", {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: png,
    })
  ).json();
  assert.equal(uploaded.ok, true);
  const downloaded = await fetch(base + uploaded.value.url);
  assert.equal(downloaded.headers.get("content-type"), "image/png");
  assert.match(downloaded.headers.get("cache-control"), /private.*immutable/);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), png);
  const invalid = await fetch(base + "/api/control-deck/media", {
    method: "POST",
    headers: { "content-type": "image/svg+xml" },
    body: "<svg/>",
  });
  assert.equal(invalid.status, 400);
});

test("bundled install grants only exact reviewed adapters and respects disabling them", async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-deck-bundled-"));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const approvalStore = require("../src/capabilities/mod-platform/packages/mod-approval-store")({
    storePath: path.join(runtimeRoot, "approvals.json"),
  });
  const bundle = require("../src/capabilities/mod-platform/packages/bundled-mods")({
    rootDir: path.resolve(__dirname, ".."),
    runtimeRoot,
    modsRoot: path.join(runtimeRoot, "installed"),
    approvalStore,
  });
  const prepared = await bundle.prepare();
  assert.deepEqual(prepared.enable, ["ravelink.twitch-clips"]);
  bundle.preference("ravelink.discord-controls", false);
  assert.deepEqual((await bundle.prepare()).enable, ["ravelink.twitch-clips"]);
  const target = path.join(runtimeRoot, "installed", "ravelink.twitch-clips", "ravelink.mod.json");
  const changed = JSON.parse(fs.readFileSync(target, "utf8"));
  changed.consumes.push("other.host.v1");
  fs.writeFileSync(target, JSON.stringify(changed));
  const again = await bundle.prepare();
  assert.equal(again.enable.length, 0);
  assert(again.results.some((row) => row.code === "bundled_mod_differs"));
});
test("default source profile starts clipping without loading retired Discord controls", async (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-deck-default-"));
  const featuresRoot = path.join(runtimeDir, "empty-features");
  fs.mkdirSync(featuresRoot);
  const desktopActions = {
    catalog: () => [],
    execute: async () => {
      throw Error("unexpected desktop mutation");
    },
    discordStatus: async () => ({ ok: true, available: false, muted: null }),
    integrations: async () => ({ discord: { available: false, muted: null } }),
    shutdown() {},
  };
  const core = createCore({
    runtimeDir,
    rootDir: path.resolve(__dirname, ".."),
    dryRun: true,
    desktopActions,
    capabilities: { features: true },
    extend: require("../src/app/optional/create-default-platform-extension")({
      rootDir: path.resolve(__dirname, ".."),
      featuresRoot,
    }),
  });
  t.after(async () => {
    await core.services.lifecycle.stopAll();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });
  await core.extension.startup;
  const mods = core.extension.mods.registry.list().mods;
  assert.deepEqual(
    mods.filter((m) => m.lifecycle === "active").map((m) => m.id),
    ["ravelink.twitch-clips"],
  );
  assert(!mods.some((m) => m.id === "ravelink.discord-controls" && m.enabled));
});
test("app-owned bundled upgrades replace only the recorded version and preserve disabled choices", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-deck-upgrade-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(rootDir, "packages"));
  fs.cpSync(
    path.resolve(__dirname, "../packages/bundled-mods"),
    path.join(rootDir, "packages/bundled-mods"),
    { recursive: true },
  );
  const runtimeRoot = path.join(rootDir, "runtime"),
    modsRoot = path.join(runtimeRoot, "installed");
  const approvalStore = require("../src/capabilities/mod-platform/packages/mod-approval-store")({
    storePath: path.join(runtimeRoot, "approvals.json"),
  });
  const createBundles = () =>
    require("../src/capabilities/mod-platform/packages/bundled-mods")({
      rootDir,
      runtimeRoot,
      modsRoot,
      approvalStore,
    });
  const first = createBundles();
  assert.equal((await first.prepare()).enable.length, 1);
  first.preference("ravelink.discord-controls", false);
  const source = path.join(rootDir, "packages/bundled-mods/discord-controls/ravelink.mod.json");
  const manifest = JSON.parse(fs.readFileSync(source, "utf8"));
  manifest.version = "1.0.2";
  fs.writeFileSync(source, JSON.stringify(manifest));
  const upgraded = await createBundles().prepare();
  assert.deepEqual(upgraded.enable, ["ravelink.twitch-clips"]);
  const installed = JSON.parse(
    fs.readFileSync(path.join(modsRoot, "ravelink.discord-controls/ravelink.mod.json"), "utf8"),
  );
  assert.equal(installed.version, "1.0.2");
  assert(
    fs
      .readdirSync(modsRoot)
      .some((name) => name.startsWith(".bundled-backup-ravelink.discord-controls")),
  );
});
