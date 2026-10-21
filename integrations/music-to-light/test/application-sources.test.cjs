const test = require("node:test"),
  assert = require("node:assert/strict"),
  { EventEmitter } = require("node:events");
const create = require("../application-sources.cjs");
const source = (pid, created, label, active = true) => ({
  id: `process:${pid}:${created}`,
  kind: "application",
  scope: "process_tree",
  label,
  active,
  peak: active ? 0.2 : 0,
});
const node = (pid, parent, created, image, pkg = "") => ({
  pid,
  parent,
  created: String(created),
  image,
  package: pkg,
});
function native(snapshot) {
  const captures = [];
  let stop;
  return {
    captures,
    available: () => true,
    applicationCatalog: async () => snapshot.value,
    capture(id) {
      captures.push(id);
      const events = new EventEmitter();
      const done = new Promise((r) => {
        stop = r;
      });
      return {
        events,
        done,
        stop: () => stop({ reason: "parent_stop" }),
        snapshot: () => ({ generation: "a".repeat(32), state: "ready" }),
      };
    },
  };
}
test("browser audio subprocesses resolve to their verified app root and survive PID changes", async () => {
  const data = {
    value: {
      sources: [source(11, 200, "firefox.exe")],
      processes: [
        node(11, 10, 200, "C:\\Browser\\firefox.exe"),
        node(10, 1, 100, "C:\\Browser\\firefox.exe"),
        node(1, 0, 10, "C:\\Windows\\explorer.exe"),
      ],
    },
  };
  const os = native(data),
    apps = create({ native: os });
  const [browser] = await apps.listSources();
  assert.match(browser.id, /^app:[a-f0-9]{64}$/);
  assert.match(browser.label, /all browser audio/);
  assert.equal(await apps.ensureAvailable(browser.id), "process:10:100");
  const saved = apps.describe(browser.id);
  assert.deepEqual(await apps.adoptExact("process:11:200"), saved);
  await assert.rejects(apps.adoptExact("process:11:199"), /music_selected_app_not_running/);
  data.value = {
    sources: [source(22, 400, "firefox.exe")],
    processes: [
      node(22, 20, 400, "C:\\Browser\\firefox.exe"),
      node(20, 1, 300, "C:\\Browser\\firefox.exe"),
    ],
  };
  const restarted = create({ native: os, known: [saved] });
  assert.equal(await restarted.ensureAvailable(browser.id), "process:20:300");
  assert.ok(!JSON.stringify(browser).includes("C:\\"));
  const capture = restarted.capture(browser.id, { seconds: 1 });
  await new Promise(setImmediate);
  assert.deepEqual(os.captures, ["process:20:300"]);
  capture.stop();
  await capture.done;
});
test("Apple Music audio agents associate through OS package family across app versions", async () => {
  const family = "AppleInc.AppleMusic_trustedpublisher";
  const data = {
    value: {
      sources: [source(51, 500, "AMPLibraryAgent.exe")],
      processes: [node(51, 1, 500, "C:\\WindowsApps\\AppleMusic_v1\\AMPLibraryAgent.exe", family)],
    },
  };
  const os = native(data),
    apps = create({ native: os });
  const [app] = await apps.listSources();
  assert.equal(app.label, "Apple Music");
  const saved = apps.describe(app.id);
  data.value = {
    sources: [source(61, 600, "AMPLibraryAgent.exe")],
    processes: [node(61, 1, 600, "C:\\WindowsApps\\AppleMusic_v2\\AMPLibraryAgent.exe", family)],
  };
  const restored = create({ native: os, known: [saved] });
  assert.equal(await restored.ensureAvailable(app.id), "process:61:600");
  assert.equal(restored.resolution().association, "windows_package");
});
test("a same-named executable elsewhere, reused parent PID and ambiguity never broaden capture", async () => {
  const data = {
    value: {
      sources: [source(2, 200, "music.exe")],
      processes: [node(2, 1, 200, "C:\\Good\\music.exe"), node(1, 0, 300, "C:\\Good\\music.exe")],
    },
  };
  const os = native(data),
    apps = create({ native: os });
  const [app] = await apps.listSources();
  assert.equal(await apps.ensureAvailable(app.id), "process:2:200");
  data.value = {
    sources: [source(3, 400, "music.exe")],
    processes: [node(3, 0, 400, "C:\\Other\\music.exe")],
  };
  await assert.rejects(apps.ensureAvailable(app.id), /music_selected_app_not_running/);
  data.value = {
    sources: [source(4, 500, "music.exe"), source(5, 600, "music.exe")],
    processes: [node(4, 0, 500, "C:\\Good\\music.exe"), node(5, 0, 600, "C:\\Good\\music.exe")],
  };
  await assert.rejects(apps.ensureAvailable(app.id), /music_selected_app_multiple_roots/);
  assert.equal(os.captures.length, 0);
});
test("Stop during source resolution cannot launch late capture", async () => {
  let finish;
  const data = {
    value: {
      sources: [source(2, 200, "music.exe")],
      processes: [node(2, 0, 200, "C:\\Good\\music.exe")],
    },
  };
  const os = native(data),
    apps = create({ native: os });
  const [app] = await apps.listSources();
  os.applicationCatalog = () =>
    new Promise((r) => {
      finish = r;
    });
  const capture = apps.capture(app.id, { seconds: 1 });
  capture.stop();
  finish(data.value);
  await capture.done;
  assert.equal(os.captures.length, 0);
});

test("priority sources select the first present app, stay pinned during capture and re-evaluate on the next start", async () => {
  const processes = [
    node(10, 0, 100, "C:\\First\\a.exe"),
    node(20, 0, 200, "C:\\Second\\b.exe"),
    node(30, 0, 300, "C:\\Third\\c.exe"),
  ];
  const data = {
    value: {
      processes,
      sources: processes.map((p) => source(p.pid, p.created, "Player " + p.pid)),
    },
  };
  const os = native(data),
    apps = create({ native: os });
  const choices = await apps.listSources(),
    ids = choices.map((s) => s.id);
  apps.setPriorities(ids);
  data.value = { processes: processes.slice(1), sources: [] };
  const first = apps.capture(ids[0], { seconds: 0 });
  await new Promise(setImmediate);
  assert.deepEqual(os.captures, ["process:20:200"]);
  assert.equal(apps.current().priority, 1);
  data.value = { processes, sources: [] }; // Main returned but is silent. It must still win on next start.
  assert.equal(apps.current().priority, 1);
  first.stop();
  await first.done;
  const second = apps.capture(ids[0], { seconds: 0 });
  await new Promise(setImmediate);
  assert.equal(os.captures.at(-1), "process:10:100");
  assert.equal(apps.current().priority, 0);
  second.stop();
  await second.done;
  data.value = { processes: processes.slice(2), sources: [] };
  assert.equal(await apps.ensureAvailable(ids[0]), "process:30:300");
  apps.setPriorities([null, null, ids[2]]);
  assert.equal(await apps.ensureAvailable(ids[2]), "process:30:300");
  assert.throws(
    () => apps.setPriorities([ids[0], ids[0], null]),
    /invalid_music_source_priorities/,
  );
  apps.setPriorities(ids);
  data.value = { processes: [...processes, node(11, 0, 110, "C:\\First\\a.exe")], sources: [] };
  await assert.rejects(apps.ensureAvailable(ids[0]), /multiple_roots/);
  data.value = { processes: [], sources: [] };
  await assert.rejects(apps.ensureAvailable(ids[0]), /not_running/);
  assert.equal(os.captures.length, 2, "checking priorities never starts idle audio capture");
});

test("remembered app resolves while silent and after its audio process restarts without discovery", async () => {
  const data = {
    value: {
      sources: [source(11, 200, "firefox.exe")],
      processes: [
        node(11, 10, 200, "C:\\Browser\\firefox.exe"),
        node(10, 0, 100, "C:\\Browser\\firefox.exe"),
      ],
    },
  };
  const os = native(data),
    apps = create({ native: os });
  const [app] = await apps.listSources();
  const restored = create({ native: os, known: [apps.describe(app.id)] });
  data.value = {
    sources: [],
    processes: [
      node(22, 20, 400, "C:\\Browser\\firefox.exe"),
      node(20, 0, 300, "C:\\Browser\\firefox.exe"),
    ],
  };
  assert.equal(await restored.ensureAvailable(app.id), "process:20:300");
  const capture = restored.capture(app.id, { seconds: 0 });
  await new Promise(setImmediate);
  assert.deepEqual(os.captures, ["process:20:300"]);
  capture.stop();
  await capture.done;
  data.value.processes.push(node(30, 0, 500, "C:\\Browser\\firefox.exe"));
  await assert.rejects(restored.ensureAvailable(app.id), /multiple_roots/);
  data.value.processes = [node(40, 0, 600, "C:\\Other\\firefox.exe")];
  await assert.rejects(restored.ensureAvailable(app.id), /not_running/);
});

test("fullscreen mode is explicit, persists without a process identity and never becomes desktop capture", async () => {
  const os = native({ value: { sources: [], processes: [] } });
  os.supportsFullscreen = true;
  os.fullscreenSource = async () => source(99, 900, "Game");
  const apps = create({ native: os });
  const rows = await apps.listSources();
  const fullscreen = rows.find((r) => r.id === "fullscreen-app");
  assert.equal(fullscreen.scope, "process_tree");
  const restored = create({ native: os, known: [apps.describe(fullscreen.id)] });
  assert.equal(await restored.ensureAvailable(fullscreen.id), "process:99:900");
  const capture = restored.capture(fullscreen.id, { seconds: 1 });
  await new Promise(setImmediate);
  assert.deepEqual(os.captures, ["process:99:900"]);
  capture.stop();
  await capture.done;
});

test("saved priorities keep a silent main app, skip unavailable fullscreen and reach fallback 2", async () => {
  const tidal = node(10, 0, 100, "C:\\Music\\TIDALPlayer.exe");
  const firefox = node(20, 0, 200, "C:\\Browser\\firefox.exe");
  const data = {
    value: {
      sources: [source(10, 100, "TIDALPlayer"), source(20, 200, "firefox")],
      processes: [tidal, firefox],
    },
  };
  const os = native(data);
  os.supportsFullscreen = true;
  let fullscreen = null,
    checks = 0;
  os.fullscreenSource = async () => {
    checks++;
    return fullscreen;
  };
  const apps = create({ native: os });
  const rows = await apps.listSources();
  const main = rows.find((r) => r.label === "TIDALPlayer");
  const browser = rows.find((r) => r.label.startsWith("firefox"));
  apps.setPriorities([main.id, "fullscreen-app", browser.id]);
  // No audio sessions at all: process existence, not volume/playback, wins.
  data.value.sources = [];
  assert.equal(await apps.ensureAvailable(main.id), "process:10:100");
  assert.equal(checks, 0, "main app presence must bypass fullscreen discovery");
  data.value.processes = [firefox];
  assert.equal(await apps.ensureAvailable(main.id), "process:20:200");
  assert.equal(apps.resolution().priority, 2);
  const capture = apps.capture(main.id, { seconds: 0 });
  await new Promise(setImmediate);
  assert.deepEqual(os.captures, ["process:20:200"]);
  assert.equal(apps.current().priority, 2);
  capture.stop();
  await capture.done;
  fullscreen = source(30, 300, "Game");
  assert.equal(await apps.ensureAvailable(main.id), "process:30:300");
  assert.equal(apps.resolution().priority, 1);
  fullscreen = null;
  data.value.processes = [];
  await assert.rejects(apps.ensureAvailable(main.id), /music_selected_app_not_running/);
});

test("fullscreen query failures do not authorize a different capture source", async () => {
  const data = {
    value: {
      sources: [source(20, 200, "firefox")],
      processes: [node(20, 0, 200, "C:\\Browser\\firefox.exe")],
    },
  };
  const os = native(data);
  os.supportsFullscreen = true;
  os.fullscreenSource = async () => {
    throw Object.assign(Error("source_query_cancelled"), { code: "source_query_cancelled" });
  };
  const apps = create({ native: os });
  const rows = await apps.listSources();
  apps.setPriorities(["fullscreen-app", null, rows.find((r) => r.id !== "fullscreen-app").id]);
  const capture = apps.capture("fullscreen-app", { seconds: 0 });
  await assert.rejects(capture.done, /source_query_cancelled/);
  assert.deepEqual(os.captures, []);
});
