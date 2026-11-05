const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const create = require("../integrations/youtube-browser/provider.cjs");
const createBridge = require("../integrations/youtube-browser/bridge.cjs");
const fixture = require("./support/youtube-browser-fixture.cjs");
const candidate = {
  provider: "youtube",
  providerItemId: "ccccccccccc",
  title: "Requested fixture",
  artists: ["Demo artist"],
  durationMs: 180000,
};
async function setup(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "youtube-browser-host-"));
  const provider = create({ runtimeDir: root, buildExtensions: false, ...overrides });
  let peer;
  t.after(async () => {
    await peer?.close();
    await provider.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    provider,
    async connect(options) {
      peer = await fixture(provider, options);
      return peer;
    },
  };
}
test("browser host confirms FIFO occurrences, preserves personal queue, bounds capacity and removes an exact duplicate", async (t) => {
  const f = await setup(t),
    peer = await f.connect();
  assert.equal((await f.provider.handle("status")).pairingCode, undefined);
  for (let index = 0; index < 10; index++)
    assert.equal(
      (
        await f.provider.handle("enqueue", {
          entryId: "request-" + index,
          candidate,
          requesterLabel: "Demo viewer",
        })
      ).appended,
      true,
    );
  const state = await f.provider.handle("status");
  assert.equal(state.capacity.available, 0);
  assert.equal(state.handoffs.length, 10);
  assert.equal(new Set(state.handoffs.map((row) => row.uid)).size, 10);
  assert.equal(peer.rows.at(-1).occurrenceId, "native:personal");
  assert.equal((await f.provider.handle("enqueue", { entryId: "overflow", candidate })).ok, false);
  const commands = peer.commands.length;
  assert.equal(
    (await f.provider.handle("enqueue", { entryId: "request-0", candidate })).appended,
    true,
  );
  assert.equal(peer.commands.length, commands);
  const removed = await f.provider.handle("remove", { entryId: "request-4" });
  assert.equal(removed.removed, 1);
  assert.deepEqual(removed.removedEntryIds, ["request-4"]);
  assert.equal(
    peer.rows.some((row) => row.occurrenceId === state.handoffs[4].uid),
    false,
  );
  assert.equal(
    peer.rows.some((row) => row.occurrenceId === state.handoffs[5].uid),
    true,
  );
  peer.play(state.handoffs[0].uid);
  await peer.poll();
  const playing = await f.provider.handle("status");
  assert.equal(playing.current.entryId, "request-0");
  assert.equal(playing.handoffs.find((row) => row.entryId === "request-0").phase, "playing");
});
test("an unconfirmed append is held across restart, and cannot be automatically sent again", async (t) => {
  const f = await setup(t, {
    createBridge: (options) => createBridge({ ...options, timeoutMs: 80 }),
  });
  const peer = await f.connect({ ignoreCommands: true });
  const result = await f.provider.handle("enqueue", { entryId: "uncertain", candidate });
  assert.equal(result.ok, false);
  await f.provider.handle("enqueue", { entryId: "uncertain", candidate });
  assert.equal(peer.commands.length, 1);
  const reopened = create({ runtimeDir: f.root, buildExtensions: false });
  t.after(() => reopened.close());
  assert.equal((await reopened.handle("status")).handoffs[0].phase, "unknown");
  assert.equal((await reopened.handle("enqueue", { entryId: "uncertain", candidate })).ok, false);
});
test("corrupt companion state disables that optional connection without throwing during Core creation", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "youtube-browser-corrupt-"));
  fs.mkdirSync(path.join(root, "youtube-browser"));
  fs.writeFileSync(path.join(root, "youtube-browser/requests.json"), "not json");
  const provider = create({ runtimeDir: root, buildExtensions: false });
  t.after(async () => {
    await provider.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  assert.equal(
    (await provider.handle("setup", { action: "start" })).error,
    "youtube_browser_journal_unavailable",
  );
  assert.equal(
    fs.readFileSync(path.join(root, "youtube-browser/requests.json"), "utf8"),
    "not json",
  );
});
