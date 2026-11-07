const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const load = import(
  "data:text/javascript;base64," +
    fs
      .readFileSync(path.join(__dirname, "../public/core/control-deck-feedback.js"))
      .toString("base64")
);
async function indicator(states, extra = {}) {
  const { deckIndicator } = await load;
  const catalog = states.map((state, i) => ({ id: String(i), available: true, state }));
  return deckIndicator({
    button: { kind: "macro", steps: catalog.map((a) => ({ actionId: a.id })) },
    catalog,
    now: 10000,
    ...extra,
  });
}
test("LED colors follow actual mute, pause and active state", async () => {
  assert.equal((await indicator([{ tone: "unmuted" }])).color, "#27c58a");
  for (const tone of ["muted", "deafened", "paused"])
    assert.equal((await indicator([{ tone }])).color, "#edb449");
  assert.equal((await indicator([{ tone: "inactive" }])).tone, "inactive");
});

test("custom toggle colors follow successful shared press state while failures retain priority", async () => {
  const { deckIndicator } = await load;
  const button = {
      kind: "macro",
      steps: [{ actionId: "first" }],
      alternateSteps: [{ actionId: "second" }],
      toggleStates: {
        off: { label: "Quiet", color: "#112233" },
        on: { label: "Live", color: "#445566" },
      },
    },
    catalog = [
      { id: "first", available: true },
      { id: "second", available: true },
    ];
  const read = (state, extra = {}) =>
    deckIndicator({ button, catalog, state, now: 10000, ...extra });
  assert.equal(read().color, "#112233");
  assert.equal(read({ toggled: true }).color, "#445566");
  assert.equal(read({ toggled: true }).label, "Live");
  assert.equal(read({ toggled: true, lastRunAt: 9900, lastResult: { ok: false } }).label, "Failed");
  assert.equal(read({ toggled: true }, { pending: true }).tone, "pending");
  assert.equal(read({ toggled: true }, { stale: true }).tone, "unknown");
});
test("LEDs distinguish unavailable controls and unknown owner state", async () => {
  assert.equal(
    (await indicator([null], { catalog: [{ id: "0", available: false }] })).tone,
    "error",
  );
  assert.equal(
    (
      await indicator([null], {
        catalog: [{ id: "0", available: false, state: { tone: "unknown" } }],
      })
    ).tone,
    "unknown",
  );
  assert.equal(
    (await indicator([{ tone: "active" }], { stale: true })).label,
    "Status connection lost",
  );
});
test("a pending clip cannot turn green when its request is merely accepted", async () => {
  const state = { lastRunAt: 9999, lastResult: { ok: true } };
  assert.equal((await indicator([{ tone: "pending" }], { state })).tone, "pending");
  assert.equal((await indicator([{ tone: "success" }], { state })).tone, "active");
  assert.equal(
    (await indicator([{ tone: "success", completedAt: 1000 }], { state })).tone,
    "rest",
    "polling an old clip cannot renew its success light",
  );
  assert.equal((await indicator([{ tone: "error" }], { state })).tone, "error");
});
test("running work and failed later macro steps override a green first step", async () => {
  assert.equal((await indicator([{ tone: "active" }], { pending: true })).tone, "pending");
  assert.equal((await indicator([{ tone: "active" }, { tone: "error" }])).tone, "error");
  assert.equal(
    (
      await indicator([{ tone: "active" }, null], {
        state: { lastRunAt: 9999, lastResult: { ok: false } },
      })
    ).label,
    "Failed",
  );
  assert.equal((await indicator([{ tone: "active" }, null])).tone, "unknown");
  assert.equal((await indicator([{ tone: "active" }, { tone: "paused" }])).tone, "mixed");
});
test("completion and failure receipts expire without replacing live state", async () => {
  const state = { lastRunAt: 9500, lastResult: { ok: true } };
  assert.equal((await indicator([null], { state })).label, "Completed");
  assert.equal((await indicator([null], { state, now: 11000 })).tone, "rest");
  const failure = { lastRunAt: 1000, lastResult: { ok: false } };
  assert.equal(
    (await indicator([{ tone: "active" }], { state: failure, now: 8999 })).tone,
    "error",
  );
  assert.equal(
    (await indicator([{ tone: "active" }], { state: failure, now: 9000 })).tone,
    "active",
  );
  assert.equal(
    (
      await indicator([null], {
        state: { lastRunAt: 9999, lastResult: { ok: false, code: "control_deck_cancelled" } },
      })
    ).label,
    "Cancelled",
  );
});
test("alternate macro cursors do not invent owner state and custom mod colors stay bounded", async () => {
  const button = { kind: "macro", steps: [{ actionId: "0" }], alternateSteps: [{ actionId: "1" }] };
  const catalog = [
    { id: "0", available: true, state: { tone: "active" } },
    { id: "1", available: true, state: { tone: "paused" } },
  ];
  assert.equal((await indicator([], { button, catalog, state: { toggled: true } })).tone, "rest");
  assert.equal((await indicator([{ tone: "active", color: "#123abc" }])).color, "#123abc");
  assert.equal(
    (await indicator([{ tone: "active", color: "url(https://invalid.test)" }])).color,
    "#27c58a",
  );
});
