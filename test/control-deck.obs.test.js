const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const fixture = require("./support/obs-fixture.cjs");
const create = require("../src/domains/control-deck/obs.service");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rvl-obs-")),
    model = fixture();
  const owner = create({
    runtimeDir: root,
    WebSocketImpl: model.WebSocketImpl,
    codec: model.codec,
  });
  t.after(() => {
    owner.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await owner.configure({ host: "127.0.0.1", port: 4455, password: model.password, enabled: true });
  return { root, model, owner };
}
test("OBS authentication, password redaction, read-only discovery and target persistence", async (t) => {
  const { root, owner, model } = await setup(t);
  assert(owner.snapshot().connection.connected);
  assert.equal(owner.snapshot().scenes.length, 2);
  assert.equal(model.writes().length, 0);
  assert.equal(
    model.identify.eventSubscriptions & (1 << 16),
    0,
    "volume meters are not subscribed",
  );
  assert(!JSON.stringify(owner.snapshot()).includes(model.password));
  assert(
    !fs
      .readFileSync(path.join(root, "system/obs-control.vault.json"), "utf8")
      .includes(model.password),
  );
  const scene = await owner.add({ kind: "scene", sceneName: "Break" });
  await owner.browse({ kind: "scene", name: "Main" });
  await owner.browse({ kind: "filters", name: "Camera" });
  await owner.screenshot("Main");
  assert.equal(model.writes().length, 0, "browsing, previewing and pinning never switches output");
  assert(owner.catalog().some((a) => a.id === scene.id));
  owner.close();
  const restored = create({
    runtimeDir: root,
    WebSocketImpl: model.WebSocketImpl,
    codec: model.codec,
  });
  t.after(() => restored.close());
  await wait(20);
  assert(restored.snapshot().connection.connected);
  assert(restored.catalog().some((a) => a.id === scene.id));
});
test("custom OBS scene, grouped source, microphone, volume and filter buttons use their exact owners", async (t) => {
  const { owner, model } = await setup(t);
  const run = async (target) => {
    const row = await owner.add(target);
    await owner.execute(row.id, {}, new AbortController().signal);
    return row;
  };
  await run({ kind: "scene", sceneName: "Break" });
  assert.equal(model.program, "Break");
  await run({
    kind: "source-toggle",
    sceneName: "Main",
    sourceName: "Camera",
    sceneItemId: 7,
    group: false,
  });
  assert.equal(model.items[0].sceneItemEnabled, false);
  await run({
    kind: "source-toggle",
    sceneName: "Graphics",
    sourceName: "Logo",
    sceneItemId: 3,
    group: true,
  });
  assert.equal(model.groupItems[0].sceneItemEnabled, false);
  const mute = await run({ kind: "mute-toggle", sourceName: "Mic" });
  assert.equal(model.muted, true);
  model.muted = false;
  model.emit("InputMuteStateChanged", { inputName: "Mic", inputMuted: false });
  assert.equal(owner.catalog().find((a) => a.id === mute.id).state.text, "Audio on");
  await owner.execute(mute.id, {}, new AbortController().signal);
  assert.equal(model.muted, true, "toggle rereads external state");
  const volume = await owner.add({ kind: "volume", sourceName: "Mic" });
  await owner.execute(volume.id, { level: 0 }, new AbortController().signal);
  assert.equal(model.volume, 0);
  await run({ kind: "filter-toggle", sourceName: "Camera", filterName: "Crop" });
  assert.equal(model.filters[0].filterEnabled, false);
  await assert.rejects(
    owner.execute(volume.id, { level: 101 }, new AbortController().signal),
    /obs_volume_invalid/,
  );
});
test("all-scene visibility includes grouped instances and brings mixed states to one destination", async (t) => {
  const { owner, model } = await setup(t);
  model.groupItems.push({ sourceName: "Camera", sceneItemId: 12, sceneItemEnabled: false });
  const target = await owner.add({ kind: "source-toggle", sourceName: "Camera", scope: "all" });
  assert.equal(model.writes().length, 0, "adding a control never changes visibility");
  assert.equal(owner.catalog().find((r) => r.id === target.id).state.text, "Mixed visibility");
  await owner.execute(target.id, {}, new AbortController().signal);
  assert.equal(model.items[0].sceneItemEnabled, true);
  assert.equal(model.groupItems.at(-1).sceneItemEnabled, true);
  const writes = model.writes().filter((r) => r.type === "SetSceneItemEnabled");
  assert.equal(writes.length, 3);
  await owner.execute(target.id, {}, new AbortController().signal);
  assert.equal(model.items[0].sceneItemEnabled, false);
  assert.equal(model.groupItems.at(-1).sceneItemEnabled, false);
  model.items.push({ sourceName: "Camera", sceneItemId: 22, sceneItemEnabled: false });
  await owner.execute(target.id, {}, new AbortController().signal);
  assert.equal(
    model.items.at(-1).sceneItemEnabled,
    true,
    "new matching instances are discovered at press time",
  );
});

test("OBS never replays an uncertain write after reconnect, and removed sources are not replaced by matching IDs", async (t) => {
  const { owner, model } = await setup(t);
  const mute = await owner.add({ kind: "mute-toggle", sourceName: "Mic" });
  model.dropNext = "SetInputMute";
  await assert.rejects(
    owner.execute(mute.id, {}, new AbortController().signal),
    /obs_disconnected/,
  );
  await wait(650);
  assert(owner.snapshot().connection.connected);
  assert.equal(model.writes().filter((r) => r.type === "SetInputMute").length, 1);
  const camera = await owner.add({
    kind: "source-toggle",
    sceneName: "Main",
    sourceName: "Camera",
    sceneItemId: 7,
    group: false,
  });
  model.items[0].sourceName = "Different camera";
  await assert.rejects(
    owner.execute(camera.id, {}, new AbortController().signal),
    /obs_source_missing/,
  );
  assert.equal(model.writes().filter((r) => r.type === "SetSceneItemEnabled").length, 0);
});
test("OBS connection and target validation reject arbitrary endpoints and method injection", async (t) => {
  const { owner } = await setup(t);
  for (const host of [
    "https://example.com",
    "example.com",
    "169.254.169.254",
    "127.0.0.1/path",
    "192.168.999.1",
  ])
    await assert.rejects(
      owner.configure({ host, port: 4455, password: "", enabled: true }),
      /obs_settings_invalid/,
    );
  await assert.rejects(
    owner.add({ kind: "arbitrary", requestType: "StartStream" }),
    /obs_target_invalid/,
  );
  await assert.rejects(
    owner.add({
      kind: "source-toggle",
      sceneName: "Main",
      sourceName: "Wrong camera",
      sceneItemId: 7,
      group: false,
    }),
    /obs_source_missing/,
  );
});
test("studio, transition and output actions use negotiated OBS methods and avoid fixed-transition duration writes", async (t) => {
  const { owner, model } = await setup(t);
  const run = async (target) => {
    const row = await owner.add(target);
    await owner.execute(row.id, {}, new AbortController().signal);
    return row;
  };
  await run({ kind: "transition-choice", transitionName: "Cut", duration: 300 });
  assert.equal(model.transition, "Cut");
  assert(!model.writes().some((r) => r.type === "SetCurrentSceneTransitionDuration"));
  await run({ kind: "transition-choice", transitionName: "Fade", duration: 500 });
  assert(
    model
      .writes()
      .some(
        (r) => r.type === "SetCurrentSceneTransitionDuration" && r.data.transitionDuration === 500,
      ),
  );
  await run({ kind: "record-toggle" });
  assert.equal(model.recording, true);
  await run({ kind: "stream-toggle" });
  assert.equal(model.streaming, true);
  await run({ kind: "virtualcam-toggle" });
  assert.equal(model.virtualCamera, true);
  await run({ kind: "studio-toggle" });
  assert.equal(model.studio, false);
  const preview = await owner.add({ kind: "preview", sceneName: "Break" });
  assert.equal(owner.catalog().find((a) => a.id === preview.id).available, false);
  const before = model.requests.length;
  await Promise.all(Array.from({ length: 8 }, () => owner.refresh()));
  assert.equal(
    model.requests.length,
    before,
    "idle callers share cached state without another polling loop",
  );
});
test("wrong OBS authentication stops automatic retries and never discloses the password", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rvl-obs-auth-")),
    model = fixture();
  const owner = create({
    runtimeDir: root,
    WebSocketImpl: model.WebSocketImpl,
    codec: model.codec,
  });
  t.after(() => {
    owner.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await assert.rejects(
    owner.configure({ host: "127.0.0.1", port: 4455, password: "wrong", enabled: true }),
    /obs_authentication_failed/,
  );
  await wait(650);
  assert.equal(model.sockets.length, 1);
  assert.equal(owner.snapshot().connection.code, "obs_authentication_failed");
  assert(!JSON.stringify(owner.snapshot()).includes("wrong"));
});
test("local OBS import is explicit and does not modify the OBS settings file", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rvl-obs-local-")),
    filename = path.join(root, "config.json"),
    calls = [];
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = JSON.stringify({
    server_enabled: true,
    server_port: 4455,
    auth_required: true,
    server_password: "local fixture secret",
  });
  fs.writeFileSync(filename, data);
  const local = require("../src/domains/control-deck/obs-local")(async (value) => {
    calls.push(value);
    return {};
  }, filename);
  assert.deepEqual(local.status(), { found: true, serverEnabled: true, port: 4455 });
  assert.equal(calls.length, 0);
  assert(!JSON.stringify(local.status()).includes("secret"));
  await local.connect();
  assert.equal(calls[0].password, "local fixture secret");
  assert.equal(fs.readFileSync(filename, "utf8"), data);
});
test("OBS buttons stay scoped to their original scene collection", async (t) => {
  const { owner, model } = await setup(t);
  const scene = await owner.add({ kind: "scene", sceneName: "Break" });
  model.collection = "Another collection";
  model.emit("CurrentSceneCollectionChanged", { sceneCollectionName: model.collection });
  assert.equal(owner.catalog().find((a) => a.id === scene.id).available, false);
  await assert.rejects(
    owner.execute(scene.id, {}, new AbortController().signal),
    /obs_collection_changed/,
  );
  assert.equal(model.writes().length, 0);
});
test(
  "OBS passwords round-trip through actual Windows protection without losing whitespace",
  { skip: process.platform !== "win32" },
  (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rvl-obs-dpapi-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const createSettings = require("../src/domains/control-deck/obs-settings"),
      password = "  fixture OBS secret \n ";
    const settings = createSettings(root);
    settings.save({ host: "127.0.0.1", port: 4455, password, enabled: true });
    const restored = createSettings(root);
    assert.equal(restored.connection().password, password);
    const saved = fs.readFileSync(path.join(root, "system/obs-control.vault.json"), "utf8");
    assert(!saved.includes("fixture OBS secret"));
    assert(!JSON.stringify(restored.publicValue()).includes("secret"));
  },
);
