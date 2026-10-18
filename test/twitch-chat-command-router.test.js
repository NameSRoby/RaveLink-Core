const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const createRouter = require("../src/capabilities/feature-platform/providers/twitch-chat-command-router");

test("native Twitch chat accepts only explicit bounded song request commands", async () => {
  let now = 1000;
  const submitted = [];
  const router = createRouter({
    now: () => now,
    submitSongRequest: async (payload) => {
      submitted.push(payload);
      return { ok: true, value: { ok: true, code: "accepted" } };
    },
  });
  const event = (text, id = "message-1", user = "user-1") => ({
    message_id: id,
    chatter_user_id: user,
    message: { text },
  });
  assert.equal(
    (await router.handle(event("!sr song"), { songRequestChatEnabled: false })).code,
    "channel_points_only",
  );
  assert.equal(
    (await router.handle(event("sr song"), { songRequestChatEnabled: true })).reason,
    "not_allowlisted",
  );
  assert.equal(
    (
      await router.handle(event("!lights red"), {
        songRequestChatEnabled: true,
      })
    ).reason,
    "not_allowlisted",
  );
  assert.equal(
    (await router.handle(event("!sr"), { songRequestChatEnabled: true })).reason,
    "invalid_command",
  );
  const unresolved = await router.handle(event("!songrequest a song"), {
    songRequestChatEnabled: true,
  });
  assert.deepEqual(unresolved, {
    handled: true,
    accepted: true,
    code: "accepted",
  });
  assert.equal(submitted[0].query, "a song");
  assert.equal(submitted[0].candidate, undefined);
  now += 1500;
  const accepted = await router.handle(
    event("!songrequest https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    { songRequestChatEnabled: true },
  );
  assert.equal(accepted.handled, true);
  assert.equal(submitted[1].candidate.provider, "youtube");
  assert.equal(submitted[1].candidate.providerItemId, "dQw4w9WgXcQ");
  assert.equal(
    (
      await router.handle(event("!sr dQw4w9WgXcQ", "message-2"), {
        songRequestChatEnabled: true,
      })
    ).reason,
    "cooldown",
  );
  now += 1500;
  assert.equal(
    (
      await router.handle(event("!sr 9bZkp7q19f0", "message-3"), {
        songRequestChatEnabled: true,
      })
    ).handled,
    true,
  );
  assert.equal(submitted[2].query, "9bZkp7q19f0");
});

test("chat moderation uses Twitch badges and gives broadcasters moderator authority", async () => {
  const moderation = [];
  const self = [];
  const router = createRouter({
    moderateSongRequest: async (payload) => {
      moderation.push(payload);
      return { ok: true, value: { ok: true, code: payload.action } };
    },
    selfManageSongRequest: async (payload) => {
      self.push(payload);
      return { ok: true, value: { ok: true, code: payload.action } };
    },
  });
  const chat = (message, overrides = {}) => ({
    message_id: crypto.randomUUID(),
    chatter_user_id: "viewer",
    chatter_user_name: "Viewer",
    broadcaster_user_id: "broadcaster",
    badges: [],
    message: { text: message },
    ...overrides,
  });
  assert.equal((await router.handle(chat("!pause"), {})).code, "moderator_required");
  await router.handle(chat("!remove"), {});
  assert.deepEqual(self[0], {
    action: "remove",
    requesterId: "viewer",
    requesterName: "Viewer",
    notifyChat: true,
    responseMessageId: self[0].responseMessageId,
  });
  await router.handle(chat("!ban @Trouble", { badges: [{ set_id: "moderator", id: "1" }] }), {});
  await router.handle(chat("!timeout @Trouble 30", { chatter_user_id: "broadcaster" }), {});
  await router.handle(chat("!bansong", { chatter_user_id: "broadcaster" }), {});
  await router.handle(chat("!volume 75", { chatter_user_id: "broadcaster" }), {});
  assert.deepEqual(
    moderation.map(({ responseMessageId, ...payload }) => payload),
    [
      {
        action: "block",
        requesterName: "@Trouble",
        removePending: true,
        notifyChat: true,
      },
      {
        action: "timeout",
        requesterName: "@Trouble",
        minutes: 30,
        removePending: true,
        notifyChat: true,
      },
      { action: "block_song", position: 1, notifyChat: true },
      { action: "volume", value: 75, notifyChat: true },
    ],
  );
});

test("VIP and moderator roles are forwarded only from trusted chat badges", async () => {
  const submitted = [];
  const router = createRouter({
    submitSongRequest: async (payload) => {
      submitted.push(payload);
      return { ok: true, value: { ok: true, code: "accepted" } };
    },
  });
  const base = {
    broadcaster_user_id: "channel",
    message: { text: "!sr dQw4w9WgXcQ" },
  };
  await router.handle(
    {
      ...base,
      message_id: "vip-message",
      chatter_user_id: "vip-user",
      chatter_user_name: "Vee",
      badges: [{ set_id: "vip", id: "1" }],
    },
    { songRequestChatEnabled: true },
  );
  await router.handle(
    {
      ...base,
      message_id: "mod-message",
      chatter_user_id: "mod-user",
      chatter_user_name: "Mod",
      badges: [{ set_id: "moderator", id: "1" }],
    },
    { songRequestChatEnabled: true },
  );
  assert.equal(submitted[0].requesterRole, "vip");
  assert.equal(submitted[1].requesterRole, "moderator");
  assert.equal(router.profileFor("vip-user").role, "vip");
});

test("command grants separate own-song access from moderation and suppress duplicate controls", async () => {
  const calls = [],
    replies = [];
  const router = createRouter({
    moderateSongRequest: async (p) => {
      calls.push(["all", p]);
      return { ok: true };
    },
    selfManageSongRequest: async (p) => {
      calls.push(["own", p]);
      return { ok: true };
    },
    reply: async (p) => replies.push(p),
  });
  const event = (message, role = "viewer") => ({
    message_id: crypto.randomUUID(),
    chatter_user_id: role,
    broadcaster_user_id: "owner",
    chatter_user_name: role,
    badges: role === "viewer" ? [] : [{ set_id: role }],
    message: { text: message },
  });
  await router.handle(event("!remove Midnight City"));
  assert.equal(calls[0][0], "own");
  assert.equal(calls[0][1].query, "Midnight City");
  await router.handle(event("!remove Midnight City", "moderator"));
  assert.equal(calls[1][0], "all");
  assert.equal(calls[1][1].query, "Midnight City");
  assert.equal((await router.handle(event("!volume 100", "vip"))).accepted, false);
  assert.equal(replies.length, 1, "permission denial is visible, not silently ignored");
  const allowed = {
    commandPermissions: { volume: { vip: true, viewer: true }, removeAny: { viewer: true } },
  };
  const volume = event("!volume 100", "vip");
  assert.equal((await router.handle(volume, allowed)).accepted, true);
  const count = calls.length;
  assert.equal((await router.handle(volume, allowed)).code, "command_duplicate");
  assert.equal(calls.length, count, "one Twitch message produces one control");
  await router.handle(event("!volume 0"), allowed);
  assert.equal(calls.at(-1)[1].value, 0);
  await router.handle(event("!remove Midnight City"), allowed);
  assert.equal(calls.at(-1)[0], "all");
  await router.handle(event("!remove Midnight City"), {
    commandPermissions: { remove: { viewer: false }, removeAny: { viewer: true } },
  });
  assert.equal(calls.length, count + 2, "any-song scope alone does not enable a disabled command");
});

for (const provider of ["youtube", "soundcloud", "tidal", "spotify"]) {
  test(`chat controls and named ownership work for ${provider}, including native handoffs`, async () => {
    const createCommands = require("../features/song-request/dist/chat-player-commands");
    const key = (user) => "req_" + crypto.createHash("sha256").update(user).digest("hex");
    const row = (id, owner, title) => ({
      id,
      entryId: id,
      requesterKey: key(owner),
      uid: id + "-uid",
      phase: "appended",
      candidate: { provider, title, providerItemId: id },
    });
    let rows = [
      row("current", "alice", "Current song"),
      row("own", "alice", "Midnight City"),
      row("other", "bob", "Someone Else"),
      row("dup1", "alice", "Duplicate"),
      row("dup2", "alice", "Duplicate"),
    ];
    const native = ["tidal", "spotify"].includes(provider),
      calls = [];
    let volume = { control: 50, floorPercent: 10, ceilingPercent: 40, outputPercent: 25 };
    const queue = {
      status: () => ({
        queue: native ? [] : rows,
        counts: { queued: native ? 0 : rows.length },
        volume,
      }),
      playbackStatus: () => ({ managed: { entryId: "current" } }),
      moderate: (p) => {
        calls.push(["queue", p]);
        if (p.action === "volume") volume = { ...volume, control: p.value };
        return { ok: true, code: p.action };
      },
      controlPlayback: (p) => {
        calls.push(["browser", p]);
        return { ok: true, code: "playback_" + p.action };
      },
    };
    const player = async (method, payload) => {
      if (method === "status")
        return { ok: true, current: { entryId: "current", uid: "current-uid" }, handoffs: rows };
      calls.push([method, payload]);
      return { ok: true, code: payload.action || method };
    };
    const route = createCommands({
      queue,
      preferences: async () => ({ ok: true, player: provider }),
      tidal: player,
      spotify: player,
      context: {
        callCapability: async (cap, method, payload) => {
          calls.push([cap, payload]);
          return { ok: true };
        },
      },
      changed: () => {},
    });
    const request = (action, extra = {}, self = false) =>
      route({
        capability: self ? "song.queue.submit.v1" : "song.queue.admin.v1",
        method: self ? "self" : "moderate",
        payload: { action, notifyChat: true, requesterId: "alice", ...extra },
      });
    assert.equal((await request("remove", { query: "Someone Else" }, true)).value.ok, false);
    assert.equal(calls.length, 0, "viewers cannot remove another user's named song");
    assert.equal((await request("skip", { entryId: "missing" })).value.ok, false);
    assert.equal(calls.length, 0, "a stale exact ID must not skip the current song instead");
    assert.equal(
      (await request("remove", { query: "Duplicate" }, true)).value.reason,
      "song_ambiguous",
    );
    assert.equal((await request("remove", { query: "Midnight City" }, true)).value.ok, true);
    assert.equal(calls.at(-1)[1].entryId, "own");
    assert.equal((await request("remove", { query: "Someone Else" })).value.ok, true);
    assert.equal(calls.at(-1)[1].entryId, "other");
    assert.equal(
      (await request("skip", { requesterId: "bob" }, true)).value.reason,
      "not_current_requester",
    );
    assert.equal((await request("skip", {}, true)).value.ok, true);
    assert.equal(calls.at(-1)[1].entryId, "current");
    await request("volume", { value: 100 });
    if (native)
      assert.ok(
        calls.some(([method, p]) =>
          provider === "tidal"
            ? method === "volume" && p.percent === 40
            : method === "control" && p.action === "volume" && p.value === 40,
        ),
      );
    assert.equal(volume.control, 100);
    await request("pause");
    await request("resume");
    assert.ok(
      calls.some(
        ([method, p]) =>
          p.action === "pause" && (native ? method !== "queue" : method === "browser"),
      ),
    );
    assert.ok(calls.some(([, p]) => p.action === "resume"));
    assert.equal(
      await route({
        capability: "song.queue.admin.v1",
        method: "moderate",
        payload: { action: "pause" },
      }),
      null,
      "operator intake controls retain their original behavior",
    );
  });
}

test("a rejected native volume change does not save a misleading local volume", async () => {
  const route = require("../features/song-request/dist/chat-player-commands")({
    preferences: async () => ({ ok: true, player: "spotify" }),
    queue: {
      status: () => ({ volume: { floorPercent: 0, ceilingPercent: 40 } }),
      moderate: () => {
        throw Error("must not save");
      },
    },
    spotify: async () => ({ ok: false, error: "spotify_companion_unavailable" }),
    changed: () => {
      throw Error("must not publish success");
    },
  });
  assert.equal(
    (
      await route({
        capability: "song.queue.admin.v1",
        method: "moderate",
        payload: { action: "volume", value: 100, notifyChat: true },
      })
    ).value.reason,
    "spotify_companion_unavailable",
  );
});

test("moderator and broadcaster skips pass the real broker without a cooldown between different songs", async () => {
  const fs = require("node:fs"),
    os = require("node:os"),
    path = require("node:path");
  const createRegistry = require("../src/capabilities/feature-platform/host/feature-host-registry");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-chat-skip-"));
  fs.cpSync(
    path.join(__dirname, "../features/song-request"),
    path.join(root, "installed/song-request"),
    { recursive: true },
  );
  const registry = createRegistry({
    featuresRoot: path.join(root, "installed"),
    runtimeRoot: path.join(root, "runtime"),
    allowUnsafeRuntime: true,
  });
  const request = (capability, method, payload) =>
    registry.request("song-request", capability, method, payload);
  try {
    assert.equal((await registry.startInstalled())[0].lifecycle, "active");
    const moderate = (p) => request("song.queue.admin.v1", "moderate", p);
    for (const [id, title] of [
      ["aaaaaaaaaaa", "First"],
      ["bbbbbbbbbbb", "Second"],
      ["ccccccccccc", "Third"],
      ["ddddddddddd", "Remove this"],
    ]) {
      const result = await request("song.queue.submit.v1", "submit", {
        requestId: id,
        requesterId: "alice",
        query: title,
        candidate: { provider: "youtube", providerItemId: id, title, artists: [], durationMs: 0 },
      });
      assert.equal(result.value?.ok, true, JSON.stringify(result));
    }
    const infoReplies = [];
    const router = createRouter({
      now: () => 1000,
      reply: async (payload) => infoReplies.push(payload),
      querySongRequest: (payload) => request("song.chat.commands.v1", "query", payload),
      moderateSongRequest: moderate,
      selfManageSongRequest: (p) => request("song.queue.submit.v1", "self", p),
    });
    const chat = (text, user = "mod") => ({
      message_id: crypto.randomUUID(),
      chatter_user_id: user,
      chatter_user_name: user,
      broadcaster_user_id: "owner",
      badges: user === "mod" ? [{ set_id: "moderator" }] : [],
      message: { text },
    });
    assert.equal((await router.handle(chat("!songqueue", "alice"))).accepted, true);
    assert.match(infoReplies.at(-1).message, /1\. First.*4\. Remove this/);
    assert.equal((await router.handle(chat("!queue", "alice"))).accepted, true);
    assert.match(infoReplies.at(-1).message, /#1.*3 more queued/);
    assert.equal((await request("song.queue.read.v1", "status", {})).value.counts.queued, 4);
    assert.equal(
      (await router.handle(chat("!remove Remove this"))).accepted,
      true,
      "named removal must omit an undefined numeric position",
    );
    await moderate({ action: "playback_start" });
    const pull = () =>
      request("song.playback.driver.v1", "pull", { driverId: "fixture", providers: ["youtube"] });
    assert.ok((await pull()).value.action);
    assert.equal(
      (await router.handle(chat("!skip", "other-viewer"))).accepted,
      false,
      "ownership stays enforced",
    );
    const first = chat("!skip");
    assert.equal(
      (await router.handle(first)).accepted,
      true,
      "moderator skip reaches the supervised worker",
    );
    assert.ok((await pull()).value.action);
    assert.equal(
      (await router.handle(first)).code,
      "command_duplicate",
      "a Twitch replay cannot skip the next song",
    );
    assert.equal(
      (await router.handle(chat("!skip", "owner"))).accepted,
      true,
      "a distinct broadcaster skip needs no clock advance",
    );
    assert.ok((await pull()).value.action);
    assert.equal(
      (await router.handle(chat("!skip", "alice"))).accepted,
      true,
      "the requester can skip their own current song immediately",
    );
  } finally {
    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("information commands have independent role grants, reject identity arguments and reply once", async () => {
  const replies = [],
    queries = [];
  const router = createRouter({
    querySongRequest: async (p) => {
      queries.push(p);
      return { ok: true, value: { ok: true, message: "Public song information" } };
    },
    reply: async (p) => replies.push(p),
  });
  const event = (text) => ({
    message_id: crypto.randomUUID(),
    chatter_user_id: "alice",
    broadcaster_user_id: "owner",
    message: { text },
  });
  for (const cmd of ["song", "songqueue", "queue"]) {
    const e = event("!" + cmd);
    assert.equal((await router.handle(e, { songRequestChatEnabled: false })).accepted, true);
    assert.equal(queries.at(-1).requesterId, "alice");
    assert.equal(queries.at(-1).command, cmd);
    assert.equal(replies.at(-1).replyParentMessageId, e.message_id);
    const count = replies.length;
    await router.handle(e, {});
    assert.equal(replies.length, count);
  }
  const before = queries.length;
  await router.handle(event("!queue @other"), {});
  assert.equal(queries.length, before);
  assert.match(replies.at(-1).message, /without arguments/);
  await router.handle(event("!song"), { commandPermissions: { song: { viewer: false } } });
  assert.equal(queries.length, before);
  assert.match(replies.at(-1).message, /permission/);
  const failed = createRouter({
    querySongRequest: async () => {
      throw Error("private credential");
    },
    reply: async (p) => replies.push(p),
  });
  await failed.handle(event("!song"), {});
  assert.match(replies.at(-1).message, /temporarily unavailable/);
  assert.doesNotMatch(replies.at(-1).message, /credential/);
});
