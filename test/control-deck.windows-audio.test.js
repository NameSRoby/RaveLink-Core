const test = require("node:test"),
  assert = require("node:assert/strict");
const create = require("../src/domains/control-deck/windows-audio.service");
const deviceKey = "device:" + "a".repeat(64),
  micKey = "device:" + "b".repeat(64),
  appKey = "app:" + "c".repeat(64);
function fixture() {
  const output = {
    key: deviceKey,
    name: "Demo speakers",
    kind: "output",
    volume: 45,
    muted: false,
    isDefault: true,
    active: true,
  };
  const input = {
    key: micKey,
    name: "Demo microphone",
    kind: "input",
    volume: 75,
    muted: false,
    isDefault: true,
    active: true,
  };
  const app = {
    key: appKey,
    name: "Demo player",
    kind: "app",
    volume: 30,
    muted: false,
    sessions: 2,
    active: true,
  };
  let state = { available: true, output, input, devices: [output, input], apps: [app] };
  const calls = [];
  const owner = create({
    available: true,
    request: async (operation, payload) => {
      calls.push({ operation, payload });
      if (operation === "audio.set") {
        const row =
          payload.target === "system"
            ? state.output
            : payload.target === "microphone"
              ? state.input
              : [...state.devices, ...state.apps].find((r) => r.key === payload.target);
        if (!row)
          throw Object.assign(Error("audio_target_unavailable"), {
            code: "audio_target_unavailable",
          });
        if (payload.action === "volume") row.volume = payload.level;
        else row.muted = payload.action === "toggle-mute" ? !row.muted : payload.muted;
      }
      return structuredClone(state);
    },
  });
  return {
    owner,
    calls,
    output,
    input,
    app,
    setState: (value) => {
      state = value;
    },
    getState: () => state,
  };
}
test("Windows mixer reads are shared and zero volume is a real slider value", async () => {
  const { owner, calls } = fixture();
  await Promise.all([owner.read(), owner.read()]);
  assert.equal(calls.length, 1);
  await owner.apply({ target: "system", action: "volume", level: 0 });
  const action = owner.catalog().find((a) => a.id === "native.audio.volume:system");
  assert.equal(action.state.value, 0);
  assert.equal(action.defaults.level, 0);
  assert.equal(action.state.tone, "inactive");
});
test("Windows mute toggles read actual state and app pins survive session changes", async () => {
  const { owner, input, app, getState } = fixture();
  await owner.read();
  await owner.execute("native.audio.mute:microphone", {});
  assert.equal(input.muted, true);
  input.muted = false;
  await owner.execute("native.audio.mute:microphone", {});
  assert.equal(input.muted, true, "external unmute must change the next decision");
  const actionId = "native.audio.controls:" + appKey;
  assert.equal(owner.catalog().find((a) => a.id === actionId).navigation.target, appKey);
  getState().apps = [];
  await owner.read(true);
  assert.equal(owner.catalog().find((a) => a.id === actionId).available, false);
  getState().apps = [{ ...app, volume: 71, sessions: 1 }];
  await owner.read(true);
  assert.equal(owner.catalog().find((a) => a.id === actionId).available, true);
  assert.equal(
    owner.catalog().find((a) => a.id === "native.audio.volume:" + appKey).state.value,
    71,
  );
});
test("Windows mixer rejects malformed commands before native dispatch", () => {
  const { owner, calls } = fixture();
  for (const value of [
    { target: "system", action: "volume", level: 101 },
    { target: "system", action: "volume", level: -1 },
    { target: "system", action: "volume", level: 1.5 },
    { target: "system", action: "mute", muted: "yes" },
    { target: "app:12", action: "toggle-mute" },
    { target: "system", action: "volume", level: 50, command: "ignored?" },
  ]) {
    assert.throws(() => owner.apply(value), /audio_(command|volume)_invalid/);
  }
  assert.equal(calls.length, 0);
});
test("cancelled queued audio changes never dispatch and malformed reads clear live status", async () => {
  let release,
    first = true;
  const writes = [];
  const { getState } = fixture();
  const owner = create({
    available: true,
    request: async (operation, payload) => {
      if (operation === "audio.status") return { available: true, devices: "bad", apps: [] };
      writes.push(payload);
      if (first) {
        first = false;
        await new Promise((resolve) => {
          release = resolve;
        });
      }
      return getState();
    },
  });
  const write = owner.apply({ target: "system", action: "volume", level: 45 });
  await new Promise((resolve) => setImmediate(resolve));
  const controller = new AbortController(),
    queued = owner.apply({ target: "microphone", action: "volume", level: 80 }, controller.signal);
  controller.abort();
  release();
  await write;
  await assert.rejects(queued, /control_deck_cancelled/);
  assert.equal(writes.length, 1);
  assert.equal((await owner.read(true)).available, false);
});
test("generic audio buttons follow a different machine's default devices without saved endpoint IDs", async () => {
  const f = fixture();
  await f.owner.read(true);
  const output = {
    ...f.output,
    key: "device:" + "d".repeat(64),
    name: "Other PC speakers",
    volume: 12,
  };
  const input = {
    ...f.input,
    key: "device:" + "e".repeat(64),
    name: "Other PC microphone",
    volume: 23,
  };
  f.setState({ available: true, output, input, devices: [output, input], apps: [] });
  await f.owner.read(true);
  await f.owner.apply({ target: "system", action: "volume", level: 35 });
  await f.owner.apply({ target: "microphone", action: "volume", level: 65 });
  assert.equal(f.getState().output.volume, 35);
  assert.equal(f.getState().input.volume, 65);
  assert.equal(f.output.volume, 45);
  assert.equal(f.input.volume, 75);
  assert.deepEqual(
    f.calls.filter((row) => row.operation === "audio.set").map((row) => row.payload.target),
    ["system", "microphone"],
  );
});

test("non-Windows mixer never starts a native helper", async () => {
  const owner = create({
    available: false,
    request: () => {
      throw Error("must not dispatch");
    },
  });
  assert.equal((await owner.read()).available, false);
  assert.throws(
    () => owner.apply({ target: "system", action: "volume", level: 50 }),
    /desktop_windows_required/,
  );
});
test(
  "Windows audio helper compiles and reads Core Audio without changing any level",
  { skip: process.platform !== "win32" },
  async (t) => {
    const path = require("node:path"),
      { spawnSync } = require("node:child_process");
    const compiled = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.resolve(__dirname, "../scripts/windows-audio-control.ps1"),
        "-SelfTest",
      ],
      { encoding: "utf8", windowsHide: true, timeout: 15000 },
    );
    assert.equal(compiled.status, 0, compiled.stderr);
    assert.equal(JSON.parse(compiled.stdout).ok, true);
    const running = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[string](Get-Service -Name Audiosrv -ErrorAction SilentlyContinue).Status",
      ],
      { encoding: "utf8", windowsHide: true, timeout: 10000 },
    );
    if (running.stdout.trim() !== "Running") {
      t.diagnostic("Audio service is not running; compile check passed.");
      return;
    }
    const bridge = require("../src/domains/control-deck/windows-bridge")({
      rootDir: path.resolve(__dirname, ".."),
      scriptName: "windows-audio-control.ps1",
      maxLineBytes: 65536,
    });
    t.after(() => bridge.shutdown());
    const state = await bridge.request("audio.status", {});
    assert.equal(state.available, true);
    assert(Array.isArray(state.devices));
    assert(Array.isArray(state.apps));
    for (const row of [...state.devices, ...state.apps]) {
      assert(/^(device|app):[a-f0-9]{64}$/.test(row.key));
      assert(!("pid" in row));
      assert(!("path" in row));
    }
  },
);
