const test = require("node:test"),
  assert = require("node:assert/strict");
test("retiring extra Discord controls preserves button appearance, order and unrelated macro work", () => {
  const step = (actionId) => ({ actionId, params: {} });
  const config = {
    pages: [
      {
        id: "main",
        buttons: [
          {
            id: "mute",
            steps: [step("mod:ravelink.discord-controls:microphone")],
            appearance: { color: "#123456" },
          },
          { id: "camera", steps: [step("mod:ravelink.discord-controls:camera")] },
          {
            id: "macro",
            steps: [step("mod:ravelink.discord-controls:open"), step("native.hotkey")],
          },
          { id: "deafen", steps: [step("mod:ravelink.discord-controls:deafen")] },
        ],
      },
    ],
  };
  const result = require("../src/domains/control-deck/retire-discord-controls")(config);
  assert.deepEqual(
    result.pages[0].buttons.map((b) => b.id),
    ["mute", "macro", "deafen"],
  );
  assert.deepEqual(result.pages[0].buttons[0].appearance, config.pages[0].buttons[0].appearance);
  assert.deepEqual(result.pages[0].buttons[0].steps, [
    { actionId: "native.hotkey", params: { shortcut: "F13" } },
  ]);
  assert.deepEqual(result.pages[0].buttons[2].steps, [
    { actionId: "native.hotkey", params: { shortcut: "F14" } },
  ]);
  assert.deepEqual(result.pages[0].buttons[1].steps, [step("native.hotkey")]);
  assert.equal(config.pages[0].buttons.length, 4);
});
test("retired Discord lifecycle/settings commands never reach the desktop bridge", async () => {
  const calls = [];
  const service = require("../src/domains/control-deck/desktop-actions.service")({
    runtimeDir: require("node:os").tmpdir(),
    platform: "win32",
    request: async (op) => {
      calls.push(op);
      return {};
    },
  });
  for (const method of ["discordControl", "discordStatus", "bindDiscord", "discordToggle"])
    assert.equal(service[method], undefined);
  service.shutdown();
  assert.deepEqual(calls, []);
});
