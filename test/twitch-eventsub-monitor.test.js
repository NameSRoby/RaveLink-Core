const test = require("node:test");
const assert = require("node:assert/strict");
const createMonitor = require("../src/capabilities/feature-platform/providers/twitch-eventsub-monitor");

class FakeSocket {
  static instances = [];
  constructor(url) { this.url = url; FakeSocket.instances.push(this); }
  emit(payload) { this.onmessage?.({ data: JSON.stringify(payload) }); }
  close() { this.onclose?.(); }
}

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
