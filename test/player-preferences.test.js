const test = require("node:test");
const assert = require("node:assert/strict");
const create = require("../features/song-request/dist/player-preferences");
test("player choice survives feature recreation and never calls a playback capability", async () => {
  const data = new Map();
  const context = {
    callCapability: async (cap, method, input) => {
      assert.equal(cap, "ravelink.storage.v1");
      if (method === "get") return { ok: true, value: data.get(input.key) };
      data.set(input.key, structuredClone(input.value));
      return { ok: true };
    },
  };
  const first = create(context);
  assert.equal((await first("status")).player, "youtube");
  assert.equal((await first("select", { player: "tidal" })).ok, true);
  const second = create(context);
  assert.equal((await second("status")).player, "tidal");
  assert.equal((await second("select", { player: "unknown" })).code, "player_invalid");
  assert.equal((await second("status")).player, "tidal");
});
test("failed preference writes do not overwrite the previous choice", async () => {
  const preference = create({
    callCapability: async (cap, method) =>
      method === "get" ? { ok: true, value: { player: "tidal" } } : { ok: false },
  });
  assert.equal((await preference("select", { player: "youtube" })).ok, false);
  assert.equal((await preference("status")).player, "tidal");
});
