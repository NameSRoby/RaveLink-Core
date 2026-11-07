const test = require("node:test"),
  assert = require("node:assert/strict");
const create = require("../src/domains/control-deck/song-volume");
test("connected TIDAL volume follows its real gain and retains exact requested values within native rounding", () => {
  const native = { connected: true, volumeAvailable: true },
    audio = {
      available: true,
      apps: [{ key: "app:" + "c".repeat(64), name: "TIDALPlayer", volume: 13 }],
    };
  const volume = { control: 100, outputPercent: 40, floorPercent: 0, ceilingPercent: 40 };
  assert.equal(create.projection("tidal", native, audio, volume).level, 33);
  volume.control = 37;
  volume.outputPercent = 15;
  audio.apps[0].volume = 15;
  assert.equal(create.projection("tidal", native, audio, volume).level, 37);
});
test("disabled desktop volume bridge uses the discovered app within request limits and reflects external levels", async () => {
  const app = { key: "app:" + "a".repeat(64), name: "TIDALPlayer", volume: 24 },
    audio = { available: true, apps: [app] },
    volume = { floorPercent: 0, ceilingPercent: 40, control: 100 },
    calls = [];
  const feature = async (cap, _method, payload) => {
    calls.push({ cap, payload });
    return {
      ok: true,
      value:
        cap === "song.player.preferences.v1"
          ? { player: "tidal" }
          : cap === "song.tidal.experimental.v1"
            ? { ok: true, enabled: false }
            : cap === "song.queue.read.v1"
              ? { volume }
              : { ok: true },
    };
  };
  const helper = create({
    feature,
    desktop: {
      audioSnapshot: () => audio,
      audioStatus: async () => audio,
      execute: async (id, params) => {
        assert.equal(id, "native.audio.volume:" + app.key);
        app.volume = params.level;
        return structuredClone(audio);
      },
    },
    getState: () => ({
      players: {
        "song.player.preferences.v1": { player: "tidal" },
        "song.tidal.experimental.v1": { enabled: false },
      },
      song: { queue: { volume } },
    }),
  });
  assert.equal(helper.describe().level, 60);
  await helper.execute(50);
  assert.equal(app.volume, 20);
  assert.deepEqual(calls.at(-1), {
    cap: "song.queue.admin.v1",
    payload: { action: "volume", value: 50 },
  });
  app.volume = 10;
  assert.equal(helper.describe().level, 25);
  audio.apps.push({ ...app, key: "app:" + "b".repeat(64) });
  await assert.rejects(helper.execute(70), /song_volume_app_unavailable/);
  assert.equal(app.volume, 10);
});
test("uncertain companion writes are not replayed through Windows audio", async () => {
  let writes = 0;
  const helper = create({
    feature: async (cap) => ({
      ok: true,
      value:
        cap === "song.player.preferences.v1"
          ? { player: "tidal" }
          : cap === "song.tidal.experimental.v1"
            ? { enabled: true, connected: true, volumeAvailable: true }
            : { ok: false, reason: "tidal_volume_unconfirmed" },
    }),
    desktop: {
      execute: async () => {
        writes++;
      },
    },
    getState: () => ({ players: {}, song: null }),
  });
  const result = await helper.execute(75);
  assert.equal(result.value.reason, "tidal_volume_unconfirmed");
  assert.equal(writes, 0);
  await assert.rejects(helper.execute(101), /parameters_invalid/);
});
