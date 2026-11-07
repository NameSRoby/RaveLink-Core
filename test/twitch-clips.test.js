const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  createTwitchApiClient,
  normalizeScopes,
} = require("../src/capabilities/feature-platform/providers/twitch-api-client");
const create = require("../src/domains/twitch/twitch-clips.service");
const flush = () => new Promise((resolve) => setImmediate(resolve));
function environment(t, options = {}) {
  let at = 0,
    calls = 0,
    reads = 0,
    replies = 0,
    found = options.found !== false;
  const timers = new Set();
  const provider = {
    status: () => ({
      connected: true,
      scopes: ["clips:edit"],
      userId: "123",
      userCode: "PRIVATE-CODE",
      accessToken: "private-token",
      ...options.auth,
    }),
    async createClip(input) {
      calls++;
      return (
        options.createResult || {
          ok: true,
          id: "ExampleClip",
          url: "https://clips.twitch.tv/ExampleClip",
          editUrl: "https://clips.twitch.tv/ExampleClip/edit",
          input,
        }
      );
    },
    async getClip() {
      reads++;
      return { ok: true, found, title: "A real title" };
    },
    async sendChat(input) {
      replies++;
      assert.match(input.message, /^Clip created: https:\/\/clips.twitch.tv\//);
    },
    async begin(input) {
      assert(input.permissionGroups.includes("clips"));
      return {
        ok: true,
        userCode: "ABCD",
        verificationUri: "https://www.twitch.tv/activate",
        authorizationExpiresAt: 2000,
        accessToken: "private-token",
      };
    },
    async poll() {
      return { ok: true, connected: true, accessToken: "private-token" };
    },
  };
  const service = create({
    getProvider: () => provider,
    now: () => at,
    confirmationMs: options.confirmationMs,
    setTimer(fn) {
      const timer = { fn, unref() {} };
      timers.add(timer);
      return timer;
    },
    clearTimer(timer) {
      timers.delete(timer);
    },
  });
  t.after(() => service.shutdown());
  return {
    service,
    provider,
    timers,
    get calls() {
      return calls;
    },
    get reads() {
      return reads;
    },
    get replies() {
      return replies;
    },
    setFound(value) {
      found = value;
    },
    async tick() {
      at += 1000;
      const next = timers.values().next().value;
      if (next) {
        timers.delete(next);
        next.fn();
      }
      await flush();
    },
  };
}
test("clip creation stays pending until Get Clips confirms publication and never starts twice", async (t) => {
  const e = environment(t, { found: false });
  assert.equal(e.service.status().available, true);
  assert.equal(e.service.status().feedback.available, true);
  assert.equal(e.service.create({ title: "3k on tracer" }).pending, true);
  assert.equal(e.service.status().feedback.state, "pending");
  assert.equal(e.service.create({}).error, "twitch_clip_busy");
  await flush();
  assert.equal(e.calls, 1);
  assert.equal(e.reads, 1);
  assert.equal(e.service.status().feedback.state, "pending");
  e.setFound(true);
  await e.tick();
  assert.equal(e.service.status().feedback.state, "success");
  const receipt = e.service.status().feedback;
  assert.equal(receipt.completedAt, 1000);
  assert.equal(receipt.jobId, e.service.status().job.id);
  await e.tick();
  assert.equal(
    e.service.status().feedback.completedAt,
    receipt.completedAt,
    "polling never renews the receipt",
  );
  assert.equal(e.service.status().job.url, "https://clips.twitch.tv/ExampleClip");
  assert.equal(e.service.create({}).error, "twitch_clip_cooldown");
  assert.equal(e.replies, 0, "deck activation does not send chat messages");
});
test("unknown create results are not retried and confirmation waits remain bounded", async (t) => {
  const timeout = environment(t, { createResult: { ok: false, error: "twitch_request_timeout" } });
  timeout.service.create({});
  await flush();
  assert.equal(timeout.calls, 1);
  assert.equal(timeout.service.status().feedback.state, "error");
  assert.equal(timeout.service.status().feedback.completedAt, 0);
  const polling = environment(t, { found: false, confirmationMs: 2000 });
  polling.service.create({});
  await flush();
  await polling.tick();
  await polling.tick();
  assert.equal(polling.service.status().job.error, "twitch_clip_not_confirmed");
  assert.equal(polling.calls, 1);
  assert.equal(polling.timers.size, 0);
  const stopping = environment(t, { found: false });
  stopping.service.create({});
  await flush();
  const reads = stopping.reads;
  await stopping.service.shutdown();
  await stopping.tick();
  assert.equal(stopping.reads, reads);
  assert.equal(stopping.timers.size, 0);
});
test("clip access is optional, explicit and never exposes authorization secrets", async (t) => {
  const e = environment(t, { auth: { scopes: [] } });
  assert.equal(e.service.status().feedback.available, false);
  assert.equal(e.service.create({}).error, "twitch_scope_missing");
  assert.equal(e.calls, 0);
  assert(!normalizeScopes().includes("clips:edit"));
  assert(normalizeScopes(["clips:edit"]).includes("clips:edit"));
  assert(!JSON.stringify(e.service.status()).includes("PRIVATE-CODE"));
  assert(!JSON.stringify(e.service.status()).includes("private-token"));
  const authorized = await e.service.beginAuthorization();
  assert.equal(authorized.userCode, "ABCD");
  assert.equal(authorized.verificationUri, "https://www.twitch.tv/activate");
  assert(!JSON.stringify(authorized).includes("private-token"));
  assert.equal((await e.service.pollAuthorization()).connected, true);
});
test("chat clipping is opt-in, channel-scoped, role-aware and deduplicated", async (t) => {
  const e = environment(t),
    event = {
      message_id: "one",
      broadcaster_user_id: "123",
      chatter_user_id: "456",
      message: { text: "!clip 3k on tracer" },
      badges: [],
    };
  assert.equal((await e.service.handleChat(event)).handled, false);
  e.service.configure({ chatEnabled: true, chatAccess: "moderators" });
  assert.equal((await e.service.handleChat(event)).error, "twitch_clip_role_required");
  event.badges = [{ set_id: "moderator" }];
  assert.equal(
    (await e.service.handleChat({ ...event, broadcaster_user_id: "999" })).error,
    "twitch_clip_channel_invalid",
  );
  assert.equal((await e.service.handleChat(event)).accepted, true);
  assert.equal((await e.service.handleChat(event)).error, "twitch_clip_message_replayed");
  await flush();
  assert.equal(e.calls, 1);
  assert.equal(e.replies, 1);
  assert.equal(e.service.status().feedback.state, "success");
});
test("clip setup persists locally and rejects unknown configuration or oversized input", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-clips-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = {
    getProvider: () => ({ status: () => ({ connected: false, scopes: [] }) }),
    storePath: path.join(root, "clips.json"),
  };
  const first = create(options);
  first.configure({ chatEnabled: true });
  assert.equal(create(options).status().config.chatEnabled, true);
  assert.throws(() => first.configure({ script: "arbitrary" }), /twitch_clip_config_invalid/);
  assert.equal(first.create({ title: "x".repeat(101) }).error, "twitch_clip_input_invalid");
  fs.writeFileSync(options.storePath, "x".repeat(4097));
  assert.equal(create(options).status().config.chatEnabled, false);
});
test("official live clip API sends titles and confirms only the owning channel", async () => {
  const requests = [],
    credentials = { clientId: "test-client", accessToken: "test-token", userId: "123" };
  let response = {
    status: 202,
    body: { data: [{ id: "ExampleClip", edit_url: "https://untrusted.invalid/editor" }] },
  };
  const api = createTwitchApiClient({
    fetch: async (url, init) => {
      requests.push({ url, init });
      return {
        ok: response.status < 400,
        status: response.status,
        text: async () => JSON.stringify(response.body),
      };
    },
  });
  const created = await api.createClip({ credentials, title: "3k on tracer", duration: 30 });
  const url = new URL(requests[0].url);
  assert.equal(url.origin, "https://api.twitch.tv");
  assert.equal(url.searchParams.get("title"), "3k on tracer");
  assert.equal(url.searchParams.get("broadcaster_id"), "123");
  assert.equal(created.editUrl, "");
  assert(!JSON.stringify(created).includes("test-token"));
  response = {
    status: 200,
    body: { data: [{ id: "ExampleClip", broadcaster_id: "999", title: "Other channel" }] },
  };
  assert.equal((await api.getClip({ credentials, id: "ExampleClip" })).found, false);
  response.body.data[0].broadcaster_id = "123";
  assert.equal((await api.getClip({ credentials, id: "ExampleClip" })).found, true);
  response = { status: 404, body: { message: "private provider details" } };
  assert.equal((await api.createClip({ credentials })).error, "twitch_stream_offline");
});

test("deck and chat titles share default moderation before the only outbound clip write", async (t) => {
  const event = {
    message_id: "moderation",
    broadcaster_user_id: "123",
    chatter_user_id: "456",
    message: { text: "!clip holy shit clutch" },
  };
  for (const chat of [false, true]) {
    const e = environment(t),
      writes = [];
    e.provider.createClip = async (input) => {
      writes.push(input);
      return { ok: true, id: "ExampleClip", url: "https://clips.twitch.tv/ExampleClip" };
    };
    e.service.configure({ chatEnabled: true });
    const result = chat
      ? await e.service.handleChat(event)
      : e.service.create({ title: "holy shit clutch" });
    assert.equal(result.ok, true);
    assert.equal(e.service.status().job.title, "holy **** clutch");
    assert.equal(e.service.status().job.titleModerated, true);
    await flush();
    assert.deepEqual(writes, [{ title: "holy **** clutch", duration: 30 }]);
  }
});

test("preview and rejected titles cannot consume cooldown, alter preferences or create a job", async (t) => {
  const e = environment(t);
  e.service.configure({ titleModeration: { mode: "reject", blockedWords: ["spoiler"] } });
  const before = e.service.status();
  assert.equal(
    e.service.previewTitle({ title: "spoiler", titleModeration: { mode: "mask" } }).title,
    "****",
  );
  assert.deepEqual(e.service.status(), before);
  assert.equal(e.service.create({ title: "spoiler" }).error, "twitch_clip_title_rejected");
  assert.deepEqual(e.service.status(), before);
  assert.equal(e.calls, 0);
  const copy = e.service.status().config;
  copy.titleModeration.blockedWords.length = 0;
  assert.equal(e.service.create({ title: "spoiler" }).ok, false);
  assert.equal(e.service.create({ title: "good title" }).ok, true);
  await flush();
  assert.equal(e.calls, 1);
  assert.throws(() => e.service.previewTitle({ title: "x", script: "bad" }), /input_invalid/);
});

test("legacy clip preferences migrate to default masking; policy changes persist independently of chat", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-clips-policy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storePath = path.join(root, "clips.json"),
    options = { storePath, getProvider: () => ({ status: () => ({}) }) };
  fs.writeFileSync(
    storePath,
    JSON.stringify({ version: 1, config: { chatEnabled: true, chatAccess: "moderators" } }),
  );
  const service = create(options);
  assert.equal(service.status().config.titleModeration.mode, "mask");
  assert.equal(service.status().config.chatEnabled, true);
  service.configure({
    titleModeration: { blockedWords: ["spoiler"], allowedWords: ["exception"] },
  });
  service.configure({ chatEnabled: false });
  assert.deepEqual(create(options).status().config, service.status().config);
  assert.throws(() => service.configure({ titleModeration: null }), /moderation_invalid/);
});
test("bundled clip action delegates to the approved host and exposes authoritative feedback", async () => {
  const entry = require("../packages/bundled-mods/twitch-clips/main");
  const calls = [];
  await entry.activate({
    callCapability: async (capability, method, payload) => {
      calls.push({ capability, method, payload });
      return method === "status"
        ? { feedback: { state: "success", label: "Clip created" } }
        : { ok: true, pending: true };
    },
  });
  assert.equal(
    (
      await entry.handleRequest({
        capability: "stream.clip.v1",
        method: "create",
        payload: { title: "3k on tracer" },
      })
    ).pending,
    true,
  );
  assert.equal(
    (await entry.handleRequest({ capability: "stream.clip.v1", method: "status" })).feedback.state,
    "success",
  );
  assert.deepEqual(calls[0], {
    capability: "twitch.clips.host.v1",
    method: "create",
    payload: { title: "3k on tracer" },
  });
  await entry.deactivate();
  assert.throws(
    () => entry.handleRequest({ capability: "stream.clip.v1", method: "create" }),
    /clip_action_unavailable/,
  );
});
