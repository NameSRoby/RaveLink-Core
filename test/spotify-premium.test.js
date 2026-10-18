const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  crypto = require("node:crypto");
const createOAuth = require("../integrations/spotify-desktop/oauth.cjs");
const createPremium = require("../integrations/spotify-desktop/premium-provider.cjs");
const URI = "spotify:track:" + "A".repeat(22),
  PERSONAL = "spotify:track:" + "B".repeat(22);
const protect = (values) => ({
  ok: true,
  encrypted: {
    fixture: Buffer.from(JSON.stringify(values)).toString("base64"),
  },
});
const unprotect = (encrypted) => ({
  ok: true,
  plain: JSON.parse(Buffer.from(encrypted.fixture, "base64").toString()),
});

test("Premium OAuth uses single-use PKCE, playback-only scopes, encrypted storage and refresh tokens", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spotify-oauth-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vaultPath = path.join(root, "vault.json"),
    calls = [];
  let now = 100000;
  const options = {
    vaultPath,
    protect,
    unprotect,
    now: () => now,
    fetch: async (url, init) => {
      calls.push({ url, body: init.body });
      return new Response(
        JSON.stringify({
          access_token: "fixture-access",
          refresh_token: "fixture-refresh",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "user-read-private user-read-playback-state user-modify-playback-state",
        }),
      );
    },
  };
  const auth = createOAuth(options);
  t.after(() => auth.close());
  assert.equal(auth.configure({ clientId: "a".repeat(32) }).ok, true);
  assert.equal(
    auth.begin({ redirectUri: "http://localhost:5050/auth/spotify/callback" }).ok,
    false,
  );
  const redirect = "http://127.0.0.1:5050/auth/spotify/callback",
    begin = auth.begin({ redirectUri: redirect }),
    url = new URL(begin.authorizationUrl);
  assert.equal(url.hostname, "accounts.spotify.com");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("scope").includes("playlist"), false);
  assert.equal(url.searchParams.get("scope").includes("streaming"), false);
  assert.equal(
    (await auth.callback({ code: "fixture-code", state: "z".repeat(43) }, redirect)).error,
    "spotify_oauth_state_invalid",
  );
  assert.equal(
    (await auth.callback({ code: "fixture-code", state: url.searchParams.get("state") }, redirect))
      .ok,
    true,
  );
  assert.equal(calls[0].body.has("client_secret"), false);
  assert.equal(
    crypto.createHash("sha256").update(calls[0].body.get("code_verifier")).digest("base64url"),
    url.searchParams.get("code_challenge"),
  );
  assert.equal(
    (await auth.callback({ code: "fixture-code", state: url.searchParams.get("state") }, redirect))
      .error,
    "spotify_oauth_session_expired",
  );
  const bytes = fs.readFileSync(vaultPath, "utf8");
  assert.equal(bytes.includes("fixture-access"), false);
  assert.equal(bytes.includes("a".repeat(32)), false);
  const restored = createOAuth(options);
  t.after(() => restored.close());
  assert.equal(await restored.authorize(), "fixture-access");
  now += 3600000;
  assert.equal(await restored.authorize(), "fixture-access");
  assert.equal(calls.at(-1).body.get("grant_type"), "refresh_token");
  assert.equal(restored.disconnect().connected, false);
  await assert.rejects(restored.authorize(), /spotify_sign_in_required/);
});

test("Premium scheduler confirms append, preserves a ten-request window, guards the device and reports unavailable queue removal", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spotify-premium-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let device = "device-a",
    selected = "device-a",
    current = PERSONAL,
    progress = 1000,
    uncertain = false,
    appended = 0;
  const queue = [],
    commands = [];
  const api = {
    profile: async () => ({
      ok: true,
      value: { account_id: "fixture-account" },
    }),
    playback: async () => ({
      ok: true,
      value: {
        item: {
          uri: current,
          name: "Current",
          artists: [],
          duration_ms: 300000,
        },
        progress_ms: progress,
        is_playing: false,
        device: { id: device, supports_volume: true },
      },
    }),
    queue: async () => ({
      ok: true,
      value: { queue: queue.map((uri) => ({ uri })) },
    }),
    append: async (uri) => {
      appended++;
      if (uncertain) return { ok: false, error: "spotify_delivery_unconfirmed" };
      queue.push(uri);
      return { ok: true };
    },
    control: async (input, target) => {
      commands.push({ input, target });
      return { ok: true };
    },
  };
  let snapshots = 0,
    queueChanges = 0;
  const options = {
    root,
    api,
    auth: { status: () => ({ connected: true }) },
    getDevice: () => selected,
    onSnapshot: () => snapshots++,
    onQueueChanged: () => queueChanges++,
  };
  const provider = createPremium(options);
  await provider.refresh();
  assert.equal(
    provider.status().ready,
    true,
    "missing deprecated product does not imply a Free account",
  );
  for (let index = 0; index < 20; index++) await provider.refresh(true);
  assert.equal(snapshots, 1, "unchanged playback must not flood the feature broker");
  assert.equal(queueChanges, 1);
  for (let index = 0; index < 10; index++)
    assert.equal(
      (
        await provider.handle("enqueue", {
          entryId: "request-" + index,
          candidate: {
            provider: "spotify",
            providerItemId: String(index).padStart(22, "A"),
            title: "Song " + index,
          },
          requesterKey: "viewer",
          requesterLabel: "Viewer",
        })
      ).appended,
      true,
    );
  assert.equal(provider.status().capacity.queued, 10);
  assert.deepEqual(
    provider.status().queueOrder,
    Array.from({ length: 10 }, (_, i) => "request-" + i),
  );
  assert.equal(
    (
      await provider.handle("enqueue", {
        entryId: "eleven",
        candidate: { providerItemId: "Z".repeat(22) },
      })
    ).error,
    "spotify_native_queue_full",
  );
  assert.equal(
    (
      await provider.handle("enqueue", {
        entryId: "request-0",
        candidate: { providerItemId: "A".repeat(21) + "0" },
      })
    ).appended,
    true,
  );
  assert.equal(appended, 10);
  assert.equal(
    (await provider.handle("remove", { entryId: "request-0" })).error,
    "spotify_queue_removal_unsupported",
  );
  current = queue.shift();
  progress = 0;
  await provider.refresh(true);
  assert.equal(provider.status().capacity.available, 1);
  assert.equal(provider.status().current.requesterLabel, "Viewer");
  const uid = provider.status().current.uid;
  assert.equal(
    (await provider.handle("control", { action: "skip", currentUid: "stale" })).error,
    "spotify_current_changed",
  );
  assert.equal((await provider.handle("control", { action: "skip", currentUid: uid })).ok, true);
  assert.equal(commands.at(-1).target, selected);
  device = "another-device";
  assert.equal(
    (
      await provider.handle("enqueue", {
        entryId: "wrong-device",
        candidate: { providerItemId: "Z".repeat(22) },
      })
    ).ok,
    false,
  );
  assert.equal(appended, 10);
  const held = provider.status().capacity.queued;
  const savedQueue = queue.splice(0);
  current = PERSONAL;
  await provider.refresh(true);
  await provider.refresh(true);
  assert.equal(
    provider.status().capacity.queued,
    held,
    "another device cannot retire queued receipts",
  );
  queue.push(...savedQueue);
  device = selected;
  uncertain = true;
  const reply = await provider.handle("enqueue", {
    entryId: "uncertain",
    candidate: { providerItemId: "Y".repeat(22) },
  });
  assert.equal(reply.error, "spotify_delivery_unconfirmed");
  const restarted = createPremium(options);
  await restarted.refresh();
  assert.equal(
    restarted.status().handoffs.find((row) => row.entryId === "uncertain").phase,
    "unknown",
  );
  await restarted.handle("enqueue", {
    entryId: "uncertain",
    candidate: { providerItemId: "Y".repeat(22) },
  });
  assert.equal(appended, 11, "an interrupted write is never replayed");
  assert.equal(JSON.stringify(restarted.status()).includes("fixture-account"), false);
});

test("Premium official transport sends bounded playback controls and treats failed writes as uncertain", async () => {
  const calls = [];
  let fail = false;
  const adapter = require("../integrations/spotify-desktop/official-adapter.cjs")({
    getAccessToken: () => "fixture-access",
    fetch: async (url, init) => {
      calls.push({ url, method: init.method });
      return new Response(null, { status: fail ? 503 : 204 });
    },
  });
  assert.equal((await adapter.control({ action: "volume", value: 25 }, "device-a")).ok, true);
  assert.match(calls[0].url, /volume_percent=25/);
  assert.equal((await adapter.control({ action: "volume", value: 101 }, "device-a")).ok, false);
  fail = true;
  assert.equal((await adapter.append(URI, "device-a")).error, "spotify_delivery_unconfirmed");
});
