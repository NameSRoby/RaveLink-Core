const test = require("node:test");
const assert = require("node:assert/strict");
const createMonitor = require("../src/capabilities/feature-platform/providers/twitch-eventsub-monitor");

class FakeSocket {
  static instances = [];
  constructor(url) { this.url = url; FakeSocket.instances.push(this); }
  emit(payload) { this.onmessage?.({ data: JSON.stringify(payload) }); }
  close() { this.onclose?.(); }
}

test('revocation during subscription creation cannot restore revoked readiness or intake', async () => {
  let complete;
  const subscription = new Promise(resolve => { complete = resolve; });
  const monitor = createMonitor({ WebSocket: FakeSocket, getCredentials: () => ({ userId: 'owner' }),
    getSubscriptionConfig: () => ({ redemptions: false, events: [{ type: 'channel.cheer', version: '1', condition: {} }] }),
    createSubscription: () => subscription });
  monitor.start();
  const socket = FakeSocket.instances.at(-1);
  socket.emit({ metadata: { message_type: 'session_welcome' }, payload: { session: { id: 'welcome' } } });
  socket.emit({ metadata: { message_type: 'revocation' }, payload: { subscription: { type: 'channel.cheer', version: '1', status: 'authorization_revoked' } } });
  complete({ ok: true }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(monitor.status().enabled, false);
  assert.equal(monitor.status().connected, false);
  assert.deepEqual(monitor.status().subscriptions, []);
  assert.equal(monitor.status().lifecycle, 'stopped');
});

test('version revocation during welcome does not revive the event or retry its retired version', async () => {
  let complete;
  const pending = new Promise(resolve => { complete = resolve; });
  const calls = [];
  const monitor = createMonitor({ WebSocket: FakeSocket, getCredentials: () => ({ userId: 'owner' }),
    getSubscriptionConfig: () => ({ redemptions: false, events: [{ type: 'channel.cheer', version: '1', condition: {} }, { type: 'channel.raid', version: '1', condition: {} }] }),
    createSubscription: row => { calls.push(row.type); return row.type === 'channel.cheer' ? pending : Promise.resolve({ ok: true }); } });
  monitor.start();
  const socket = FakeSocket.instances.at(-1);
  socket.emit({ metadata: { message_type: 'session_welcome' }, payload: { session: { id: 'welcome' } } });
  socket.emit({ metadata: { message_type: 'revocation' }, payload: { subscription: { type: 'channel.cheer', version: '1', status: 'version_removed' } } });
  complete({ ok: true }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(monitor.status().lifecycle, 'degraded');
  assert.deepEqual(monitor.status().subscriptions, ['channel.raid']);
  monitor.restart();
  FakeSocket.instances.at(-1).emit({ metadata: { message_type: 'session_welcome' }, payload: { session: { id: 'next' } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(type => type === 'channel.cheer').length, 1);
  monitor.stop();
});

test('a permanently rejected subscription is isolated without reconnecting or retrying it', async () => {
  const calls = [], failures = [];
  const monitor = createMonitor({ WebSocket: FakeSocket, getCredentials: () => ({ userId: 'owner' }),
    getSubscriptionConfig: () => ({ redemptions: false, events: [{ type: 'channel.cheer', version: '1' }, { type: 'channel.raid', version: '1' }] }),
    createSubscription: async row => { calls.push(row.type); return row.type === 'channel.cheer' ? { ok: false, status: 403, error: 'twitch_eventsub_subscription_failed' } : { ok: true }; },
    onRevocation: row => failures.push(row) });
  monitor.start();
  FakeSocket.instances.at(-1).emit({ metadata: { message_type: 'session_welcome' }, payload: { session: { id: 'welcome' } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(monitor.status().connected, true);
  assert.equal(monitor.status().lifecycle, 'degraded');
  assert.deepEqual(monitor.status().subscriptions, ['channel.raid']);
  assert.deepEqual(failures, [{ type: 'channel.cheer', version: '1', reason: 'unknown' }]);
  monitor.restart();
  FakeSocket.instances.at(-1).emit({ metadata: { message_type: 'session_welcome' }, payload: { session: { id: 'next' } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(type => type === 'channel.cheer').length, 1);
  monitor.stop();
});

test('a rejected grant during the final subscription cannot restore connected state', async () => {
  const monitor = createMonitor({ WebSocket: FakeSocket, getCredentials: () => ({ userId: 'owner' }),
    getSubscriptionConfig: () => ({ redemptions: false, events: [{ type: 'channel.cheer', version: '1' }] }),
    createSubscription: async () => ({ ok: false, status: 401 }) });
  monitor.start();
  FakeSocket.instances.at(-1).emit({ metadata: { message_type: 'session_welcome' }, payload: { session: { id: 'welcome' } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(monitor.status().enabled, false);
  assert.equal(monitor.status().lifecycle, 'stopped');
  assert.equal(monitor.status().connected, false);
});

test("EventSub monitor subscribes, deduplicates notifications, and stops cleanly", async () => {
  FakeSocket.instances.length = 0;
  const subscriptions = [];
  const redemptions = [];
  const chats = [];
  const monitor = createMonitor({
    WebSocket: FakeSocket,
    getCredentials: () => ({ userId: "user-1" }),
    createSubscription: async input => { subscriptions.push(input); return { ok: true }; },
    onRedemption: async event => redemptions.push(event),
    onChat: async event => chats.push(event)
  });
  monitor.start();
  const socket = FakeSocket.instances[0];
  socket.emit({ metadata: { message_id: "welcome", message_type: "session_welcome" }, payload: { session: { id: "session-1", keepalive_timeout_seconds: 10 } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(subscriptions.map(row => row.type), ["channel.channel_points_custom_reward_redemption.add", "channel.chat.message"]);
  const notification = { metadata: { message_id: "event-1", message_type: "notification" }, payload: { subscription: { type: "channel.channel_points_custom_reward_redemption.add" }, event: { id: "redemption-1" } } };
  socket.emit(notification);
  socket.emit(notification);
  socket.emit({ metadata: { message_id: "event-2", message_type: "notification" }, payload: { subscription: { type: "channel.chat.message" }, event: { message_id: "chat-1", message: { text: "!sr song" } } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(redemptions.length, 1);
  assert.equal(chats.length, 1);
  assert.equal(monitor.status().counters.duplicates, 1);
  socket.emit({ metadata: { message_id: "reconnect", message_type: "session_reconnect" }, payload: { session: { reconnect_url: "wss://eventsub.wss.twitch.tv/ws?reconnect=1" } } });
  const replacement = FakeSocket.instances[1];
  socket.emit({ metadata: { message_id: "event-3", message_type: "notification" }, payload: { subscription: { type: "channel.chat.message" }, event: { message_id: "chat-2", message: { text: "!sr before welcome" } } } });
  assert.equal(chats.length, 2);
  replacement.emit({ metadata: { message_id: "welcome-2", message_type: "session_welcome" }, payload: { session: { id: "session-2", keepalive_timeout_seconds: 10 } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(subscriptions.length, 2);
  assert.equal(monitor.stop().lifecycle, "stopped");
});

test("EventSub monitor does not subscribe to chat when chat intake is disabled", async () => {
  FakeSocket.instances.length = 0;
  const subscriptions = [];
  const monitor = createMonitor({
    WebSocket: FakeSocket,
    getCredentials: () => ({ userId: "user-1" }),
    getSubscriptionConfig: () => ({ redemptions: true, chat: false }),
    createSubscription: async input => { subscriptions.push(input); return { ok: true }; }
  });
  monitor.start();
  monitor.start();
  assert.equal(FakeSocket.instances.length, 1);
  FakeSocket.instances[0].emit({ metadata: { message_id: "welcome", message_type: "session_welcome" }, payload: { session: { id: "session-1", keepalive_timeout_seconds: 10 } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(subscriptions.map(row => row.type), ["channel.channel_points_custom_reward_redemption.add"]);
  monitor.stop();
});

test("EventSub monitor subscribes to configured Twitch alert events and dispatches them", async () => {
  FakeSocket.instances.length = 0;
  const subscriptions = [], events = [];
  const monitor = createMonitor({
    WebSocket: FakeSocket,
    getCredentials: () => ({ userId: "user-1" }),
    getSubscriptionConfig: () => ({ redemptions: false, chat: false, events: [
      { type: "channel.follow", version: "2", condition: { broadcaster_user_id: "user-1", moderator_user_id: "user-1" } },
      { type: "channel.raid", version: "1", condition: { to_broadcaster_user_id: "user-1" } }
    ] }),
    createSubscription: async input => { subscriptions.push(input); return { ok: true }; },
    onEvent: async (type, event, metadata) => events.push({ type, event, messageId: metadata.message_id })
  });
  monitor.start();
  const socket = FakeSocket.instances[0];
  socket.emit({ metadata: { message_id: "welcome-alerts", message_type: "session_welcome" }, payload: { session: { id: "session-alerts", keepalive_timeout_seconds: 10 } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(subscriptions.map(row => row.type), ["channel.follow", "channel.raid"]);
  socket.emit({ metadata: { message_id: "raid-1", message_type: "notification" }, payload: { subscription: { type: "channel.raid" }, event: { from_broadcaster_user_name: "Raider" } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, [{ type: "channel.raid", event: { from_broadcaster_user_name: "Raider" }, messageId: "raid-1" }]);
  monitor.stop();
});

test("EventSub monitor rejects reconnect URLs outside Twitch's fixed secure origin", () => {
  FakeSocket.instances.length = 0;
  const monitor = createMonitor({
    WebSocket: FakeSocket,
    getCredentials: () => ({ userId: "user-1" }),
    createSubscription: async () => ({ ok: true })
  });
  monitor.start();
  FakeSocket.instances[0].emit({
    metadata: { message_id: "unsafe-reconnect", message_type: "session_reconnect" },
    payload: { session: { reconnect_url: "wss://attacker.invalid/internal" } }
  });
  assert.equal(FakeSocket.instances.length, 1);
  monitor.stop();
});
