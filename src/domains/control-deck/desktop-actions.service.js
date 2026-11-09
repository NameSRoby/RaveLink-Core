/** Operator-triggered Windows keyboard, media and application actions.
 * Settings contain no app tokens. Test adapters never touch keyboard or desktop.
 */
const fs = require("node:fs"),
  path = require("node:path");
const fault = (code) => Object.assign(Error(code), { code });
const MEDIA = {
  playPause: 0xb3,
  next: 0xb0,
  previous: 0xb1,
  stop: 0xb2,
  mute: 0xad,
  volumeUp: 0xaf,
  volumeDown: 0xae,
};
const NAMED = {
  SPACE: 32,
  ENTER: 13,
  TAB: 9,
  ESCAPE: 27,
  ESC: 27,
  BACKSPACE: 8,
  DELETE: 46,
  INSERT: 45,
  HOME: 36,
  END: 35,
  PAGEUP: 33,
  PAGEDOWN: 34,
  UP: 38,
  DOWN: 40,
  LEFT: 37,
  RIGHT: 39,
  MINUS: 189,
  PLUS: 187,
};
const MODIFIERS = { CTRL: 17, CONTROL: 17, SHIFT: 16, ALT: 18, WIN: 91, WINDOWS: 91 };
function hotkey(value) {
  if (typeof value !== "string" || value.length > 100) throw fault("desktop_hotkey_invalid");
  const parts = value
    .toUpperCase()
    .split("+")
    .map((p) => p.trim());
  const key = parts.pop(),
    modifiers = parts.map((p) => MODIFIERS[p]);
  let vk = NAMED[key];
  if (/^[A-Z0-9]$/.test(key)) vk = key.charCodeAt(0);
  if (/^F(?:[1-9]|1\d|2[0-4])$/.test(key)) vk = 111 + Number(key.slice(1));
  if (
    !vk ||
    modifiers.some((n) => !n) ||
    new Set(modifiers).size !== modifiers.length ||
    modifiers.length > 4
  )
    throw fault("desktop_hotkey_invalid");
  if (key === "PLUS" && !modifiers.includes(16)) modifiers.push(16);
  return [...modifiers, vk];
}
const object = (properties, required) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});
module.exports = function createDesktopActions({
  rootDir,
  platform = process.platform,
  request: injected,
  nativeVolume,
  bridgeOptions = {},
} = {}) {
  const bridge = injected ? null : require("./windows-bridge")({ rootDir, ...bridgeOptions });
  const request = injected || bridge.request;
  const available = platform === "win32";
  const audioBridge = injected
    ? null
    : require("./windows-bridge")({
        rootDir,
        scriptName: "windows-audio-control.ps1",
        maxLineBytes: 65536,
        ...bridgeOptions,
      });
  const audio = require("./windows-audio.service")({
    available,
    nativeVolume,
    request: injected || audioBridge.request,
  });
  function windows() {
    if (!available) throw fault("desktop_windows_required");
  }
  function catalog() {
    const row = (id, label, symbol, properties, required, defaults) => ({
      id,
      label,
      symbol,
      group: "This Windows PC",
      description:
        "Runs on the computer hosting RaveLink, including when pressed from your LAN browser.",
      available,
      parameters: object(properties, required),
      defaults,
    });
    return [
      ...audio.catalog(),
      row(
        "native.hotkey",
        "Keyboard shortcut",
        "⌨",
        { shortcut: { type: "string", title: "Key or combination", minLength: 1, maxLength: 100 } },
        ["shortcut"],
        { shortcut: "F13" },
      ),
      row(
        "native.text",
        "Type text",
        "T",
        { text: { type: "string", minLength: 1, maxLength: 1000 } },
        ["text"],
        { text: "Hello" },
      ),
      row(
        "native.media",
        "Media / volume key",
        "♫",
        { key: { type: "string", enum: Object.keys(MEDIA) } },
        ["key"],
        { key: "playPause" },
      ),
      row(
        "native.open",
        "Open app, file or website",
        "↗",
        { target: { type: "string", minLength: 1, maxLength: 2048 } },
        ["target"],
        { target: "https://example.com" },
      ),
    ];
  }
  async function execute(id, params = {}, signal) {
    windows();
    if (signal?.aborted) throw fault("control_deck_cancelled");
    if (id.startsWith("native.audio.")) return audio.execute(id, params, signal);
    if (id === "native.hotkey") return request("keys", { keys: hotkey(params.shortcut) }, signal);
    if (id === "native.text") {
      if (
        typeof params.text !== "string" ||
        !params.text.length ||
        params.text.length > 1000 ||
        params.text.includes("\0")
      )
        throw fault("desktop_text_invalid");
      return request("text", { text: params.text }, signal);
    }
    if (id === "native.media") {
      if (!Object.hasOwn(MEDIA, params.key)) throw fault("desktop_media_invalid");
      return request("keys", { keys: [MEDIA[params.key]] }, signal);
    }
    if (id === "native.open") {
      const target = params.target;
      if (typeof target !== "string" || target.length > 2048 || /[\x00-\x1f]/.test(target))
        throw fault("desktop_target_invalid");
      if (/^https?:\/\//i.test(target)) {
        const url = new URL(target);
        if (url.username || url.password) throw fault("desktop_target_invalid");
      } else if (
        !/^[a-z]:[\\/]/i.test(target) ||
        !path.win32.isAbsolute(target) ||
        !fs.existsSync(target)
      )
        throw fault("desktop_target_invalid");
      return request("open", { target }, signal);
    }
    throw fault("control_deck_action_unavailable");
  }
  return {
    catalog,
    execute,
    audioStatus: audio.read,
    audioSnapshot: audio.snapshot,
    audioApply: audio.apply,
    refresh: audio.read,
    shutdown: () => {
      audio.shutdown();
      audioBridge?.shutdown();
      bridge?.shutdown();
    },
  };
};
module.exports.hotkey = hotkey;
