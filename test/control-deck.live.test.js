const test = require("node:test"),
  assert = require("node:assert/strict");
const live = require("../src/domains/control-deck/control-deck-live");
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
test("visible screens share one refresh loop, unchanged frames stay quiet, and the last disconnect stops work", async () => {
  let reads = 0,
    state = 0;
  const hub = live({
    intervalMs: 20,
    read: () => ({ state, updatedAt: Date.now() }),
    refresh: () => {
      reads++;
    },
  });
  const a = [],
    b = [],
    offA = hub.listen((f) => a.push(JSON.parse(f))),
    offB = hub.listen((f) => b.push(JSON.parse(f)));
  try {
    await pause(65);
    assert.ok(reads >= 2 && reads <= 5);
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    state = 1;
    hub.current(); // An HTTP refresh must not consume another screen's update.
    hub.changed();
    await pause(30);
    assert.equal(a.at(-1).value.state, 1);
    assert.equal(a.at(-1).version, b.at(-1).version);
    offA();
    offB();
    const prior = reads;
    await pause(50);
    assert.equal(reads, prior);
  } finally {
    offA();
    offB();
    hub.close();
  }
});
test("slow mod reads do not block fast owners; a confirmed press is available without another scan", async () => {
  let finish;
  const blocked = new Promise((r) => {
    finish = r;
  });
  const feedback = { label: "Muted", state: "muted", active: true };
  const owner = require("../src/domains/control-deck/control-deck-actions")({
    core: { lightingProfiles: { snapshot: () => ({ profiles: [] }) } },
    music: {},
    desktop: { catalog: () => [], refresh: async () => {} },
    getMods: () => ({
      list: () => ({
        mods: [
          {
            id: "test",
            name: "Test",
            lifecycle: "active",
            actions: [{ id: "mute", title: "Mute", stateMethod: "status" }],
          },
        ],
      }),
      readActionState: () => blocked,
      invokeAction: async () => ({ ok: true, value: { feedback } }),
    }),
  });
  try {
    await Promise.race([
      owner.refreshLive(),
      pause(200).then(() => {
        throw Error("fast state blocked by mod");
      }),
    ]);
    await owner.execute("mod:test:mute", {}, new AbortController().signal);
    assert.equal(owner.feedback()["mod:test:mute"].text, "Muted");
  } finally {
    finish({ ok: true, value: { feedback } });
    await owner.refresh();
  }
});
