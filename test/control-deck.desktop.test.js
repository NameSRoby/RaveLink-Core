const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const create = require("../src/domains/control-deck/desktop-actions.service");

test(
  "real Windows JSON helper accepts key types and returns bounded validation errors without injecting input",
  { skip: process.platform !== "win32" },
  async (t) => {
    const bridge = require("../src/domains/control-deck/windows-bridge")({
      rootDir: path.resolve(__dirname, ".."),
    });
    t.after(() => bridge.shutdown());
    await assert.rejects(
      bridge.request("keys", { keys: [] }),
      (error) => error.code === "desktop_hotkey_invalid",
    );
  },
);
test("desktop macros use validated data, not a command-language boundary", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ravelink-desktop-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const service = create({
    runtimeDir: root,
    platform: "win32",
    request: async (operation, payload) => {
      calls.push({ operation, payload });
      return { ok: true };
    },
  });
  await service.execute("native.hotkey", { shortcut: "Ctrl+Shift+M" });
  assert.deepEqual(calls[0], { operation: "keys", payload: { keys: [17, 16, 77] } });
  await service.execute("native.text", { text: 'Hello $(`literal`) "world"' });
  assert.equal(calls[1].payload.text, 'Hello $(`literal`) "world"');
  await service.execute("native.media", { key: "volumeUp" });
  assert.equal(calls[2].payload.keys[0], 175);
  await service.execute("native.open", { target: "https://example.com/path?a=1&b=2" });
  assert.equal(calls[3].operation, "open");
  for (const params of [
    { shortcut: "Ctrl+Shift+NoSuchKey" },
    { shortcut: "Ctrl+Ctrl+A" },
    { shortcut: "Ctrl+A; calc.exe" },
  ])
    await assert.rejects(service.execute("native.hotkey", params), /desktop_hotkey_invalid/);
  for (const target of [
    "javascript:alert(1)",
    "file:///C:/something.exe",
    "https://user:password@example.com",
    "C:\\missing\\not-here.exe",
    "https://example.com\n",
  ])
    await assert.rejects(service.execute("native.open", { target }), /desktop_target_invalid/);
  assert.equal(calls.length, 4);
  await service.execute("native.hotkey", { shortcut: "F13" });
  await service.execute("native.hotkey", { shortcut: "F14" });
  assert.deepEqual(calls.slice(-2), [
    { operation: "keys", payload: { keys: [124] } },
    { operation: "keys", payload: { keys: [125] } },
  ]);
  for (let key = 13; key <= 24; key++) {
    await service.execute("native.hotkey", { shortcut: "Ctrl+Shift+F" + key });
    assert.deepEqual(calls.at(-1).payload.keys, [17, 16, 111 + key]);
  }
  await assert.rejects(
    service.execute("native.hotkey", { shortcut: "F25" }),
    /desktop_hotkey_invalid/,
  );
  assert.equal(service.discordControl, undefined);
  assert.equal(service.prepareDiscord, undefined);
  assert.equal(service.setDiscordStreamer, undefined);
});
test(
  "Windows adapter ABI self-test never injects keyboard input",
  { skip: process.platform !== "win32" },
  () => {
    const { spawnSync } = require("node:child_process");
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.resolve("scripts/windows-control-deck.ps1"),
        "-SelfTest",
      ],
      { windowsHide: true, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout.trim());
    assert.equal(value.inputSize, 40);
    assert.equal(value.ok, true);
  },
);
