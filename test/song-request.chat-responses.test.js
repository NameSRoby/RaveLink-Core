const test = require("node:test");
const assert = require("node:assert/strict");
const { RESPONSE_KINDS, composeChatResponse, responseKind } = require("../features/song-request/dist/chat-responses");

const enabled = kind => ({ responses: { [kind]: true }, queue: [] });

test("native Song Request chat outcomes are independently gated and sanitized", () => {
  const request = { method: "submit", payload: { notifyChat: true, responseMessageId: "message-1", requesterName: "Viewer", query: "Example song" } };
  assert.equal(composeChatResponse(request, { ok: true, position: 2 }, { responses: {}, queue: [] }), null);
  assert.deepEqual(composeChatResponse(request, { ok: true, position: 2 }, enabled("queued")), {
    kind: "queued", message: '@Viewer Queued "Example song" at position 2.', replyParentMessageId: "message-1"
  });
  assert.equal(composeChatResponse({ ...request, payload: { ...request.payload, notifyChat: false } }, { ok: true }, enabled("queued")), null);
  assert.equal(RESPONSE_KINDS.length, new Set(RESPONSE_KINDS).size);
});

test("response classification covers moderation success and failure without raw errors", () => {
  assert.equal(responseKind({ method: "moderate", payload: { action: "block_song" } }, { ok: true }), "song_ban_succeeded");
  assert.equal(responseKind({ method: "moderate", payload: { action: "remove" } }, { ok: false }), "remove_failed");
  const response = composeChatResponse(
    { method: "moderate", payload: { action: "remove", notifyChat: true } },
    { ok: false, reason: "entry_not_found", error: "private backend detail" },
    enabled("remove_failed")
  );
  assert.equal(response.message, "Remove failed: the requested queue item was not found.");
  assert.equal(response.message.includes("private backend detail"), false);
  const unrelatedQueue = { responses: { remove_failed: true }, queue: [{ id: "other", candidate: { title: "Wrong track" } }] };
  assert.equal(composeChatResponse(
    { method: "moderate", payload: { action: "remove", notifyChat: true } },
    { ok: false, reason: "entry_not_found" },
    unrelatedQueue
  ).message, "Remove failed: the requested queue item was not found.");
});

test("now-playing replies require a Twitch-origin queue entry", () => {
  const request = { method: "acknowledge", payload: {} };
  assert.equal(composeChatResponse(request, { ok: true, code: "started", notifyChat: false }, enabled("now_playing")), null);
  const response = composeChatResponse(request, {
    ok: true, code: "started", notifyChat: true, entryId: "song-1"
  }, {
    responses: { now_playing: true },
    queue: [{ id: "song-1", requesterLabel: "Viewer", candidate: { title: "Track" } }]
  });
  assert.equal(response.message, 'Now playing "Track", requested by @Viewer.');
});
