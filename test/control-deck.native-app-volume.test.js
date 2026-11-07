const test = require("node:test"),
  assert = require("node:assert/strict");
const native = require("../src/domains/control-deck/native-app-volume");
const audioService = require("../src/domains/control-deck/windows-audio.service");
test("TIDAL mixer writes update its saved native gain and remain stable on a new song", async () => {
  const row = {
    key: "app:" + "a".repeat(64),
    name: "TIDALPlayer",
    kind: "app",
    volume: 13,
    muted: false,
    sessions: 1,
  };
  let stored = 13,
    windowsWrites = 0,
    nativeWrites = 0;
  const route = native(() => ({
    list: () => ({ features: [{ id: "song-request", lifecycle: "active" }] }),
    request: async (_feature, _cap, method, payload) => {
      if (method === "status")
        return { ok: true, value: { connected: true, volumeAvailable: true } };
      nativeWrites++;
      stored = row.volume = payload.percent;
      return { ok: true, value: { ok: true, percent: stored } };
    },
  }));
  const audio = audioService({
    available: true,
    nativeVolume: route,
    request: async (operation) => {
      if (operation === "audio.set") windowsWrites++;
      return { available: true, output: null, input: null, devices: [], apps: [{ ...row }] };
    },
  });
  await audio.read();
  await audio.apply({ target: row.key, action: "volume", level: 12 });
  row.volume = stored; // The player applies its saved gain when the next track starts.
  assert.equal((await audio.read(true)).apps[0].volume, 12);
  assert.equal(nativeWrites, 1);
  assert.equal(windowsWrites, 0);
  await audio.shutdown();
});
test("unknown native volume outcomes never fall back to a second Windows write", async () => {
  const row = { key: "app:" + "b".repeat(64), name: "TIDALPlayer", kind: "app", volume: 13 };
  let windowsWrites = 0;
  const route = native(() => ({
    list: () => ({ features: [{ id: "song-request", lifecycle: "active" }] }),
    request: async (_f, _c, method) =>
      method === "status"
        ? { ok: true, value: { connected: true, volumeAvailable: true } }
        : { ok: false, error: { code: "timeout" } },
  }));
  const audio = audioService({
    available: true,
    nativeVolume: route,
    request: async (op) => {
      if (op === "audio.set") windowsWrites++;
      return { available: true, output: null, input: null, devices: [], apps: [row] };
    },
  });
  await audio.read();
  await assert.rejects(
    audio.apply({ target: row.key, action: "volume", level: 12 }),
    /native_change_unconfirmed/,
  );
  assert.equal(windowsWrites, 0);
  await audio.shutdown();
});
test("other apps and disconnected companions retain Windows volume ownership", async () => {
  const route = native(() => ({
    list: () => ({ features: [{ id: "song-request", lifecycle: "active" }] }),
    request: async () => ({ ok: true, value: { connected: false } }),
  }));
  assert.equal(await route({ kind: "app", name: "Demo game" }, 50), false);
  assert.equal(await route({ kind: "output", name: "TIDALPlayer" }, 50), false);
  assert.equal(await route({ kind: "app", name: "TIDALPlayer" }, 50), false);
});
