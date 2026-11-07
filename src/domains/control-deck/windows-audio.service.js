/** Core-owned Windows mixer. IDs represent current devices/apps, never saved PIDs. */
const { fault } = require("./control-deck-config");
const keyPattern = /^(system|microphone|(?:device|app):[a-f0-9]{64})$/;
const empty = { type: "object", additionalProperties: false, properties: {} };
module.exports = function createWindowsAudio({ request, available, now = Date.now }) {
  let state = {
    available: false,
    code: available ? "audio_waiting" : "desktop_windows_required",
    output: null,
    input: null,
    devices: [],
    apps: [],
    updatedAt: 0,
  };
  let flight,
    after = 0,
    chain = Promise.resolve(),
    closed = false,
    epoch = 0,
    pendingWrites = 0;
  const seen = new Map();
  function row(value, kind) {
    if (
      !value ||
      typeof value.name !== "string" ||
      !/^(device|app):[a-f0-9]{64}$/.test(value.key) ||
      !["output", "input", "app"].includes(value.kind) ||
      (kind && value.kind !== kind)
    )
      throw fault("audio_state_invalid");
    return {
      key: value.key,
      name: value.name.replace(/[\x00-\x1f]/g, " ").slice(0, 128),
      kind: value.kind,
      volume:
        Number.isInteger(value.volume) && value.volume >= 0 && value.volume <= 100
          ? value.volume
          : null,
      muted: typeof value.muted === "boolean" ? value.muted : null,
      mixed: value.mixed === true,
      active: value.active === true,
      isDefault: value.isDefault === true,
      sessions:
        Number.isInteger(value.sessions) && value.sessions >= 0 ? Math.min(value.sessions, 256) : 0,
    };
  }
  function accept(value) {
    if (
      value?.available !== true ||
      !Array.isArray(value.devices) ||
      value.devices.length > 64 ||
      !Array.isArray(value.apps) ||
      value.apps.length > 64
    )
      throw fault("audio_state_invalid");
    const next = {
      available: true,
      output: value.output ? row(value.output, "output") : null,
      input: value.input ? row(value.input, "input") : null,
      devices: value.devices.map((v) => row(v)),
      apps: value.apps.map((v) => row(v, "app")),
      updatedAt: now(),
    };
    for (const item of [...next.devices, ...next.apps]) {
      seen.delete(item.key);
      seen.set(item.key, item);
    }
    while (seen.size > 58) seen.delete(seen.keys().next().value);
    state = next;
    after = now() + 400;
    return snapshot();
  }
  function snapshot() {
    return structuredClone(state);
  }
  async function read(force = false) {
    if (closed || !available) return snapshot();
    if (!force && now() < after) return snapshot();
    if (flight) return flight;
    const revision = epoch;
    flight = Promise.resolve()
      .then(() => request("audio.status", {}))
      .then((value) => (revision === epoch ? accept(value) : snapshot()))
      .catch((error) => {
        if (revision === epoch) {
          state = {
            available: false,
            code: error.code || "audio_state_unavailable",
            output: null,
            input: null,
            devices: [],
            apps: [],
            updatedAt: now(),
          };
          after = now() + 750;
        }
        return snapshot();
      })
      .finally(() => {
        flight = null;
      });
    return flight;
  }
  function validate(value) {
    if (
      !value ||
      typeof value !== "object" ||
      Object.keys(value).some((k) => !["target", "action", "level", "muted"].includes(k)) ||
      !keyPattern.test(value.target) ||
      !["volume", "mute", "toggle-mute"].includes(value.action)
    )
      throw fault("audio_command_invalid");
    if (
      value.action === "volume" &&
      (!Number.isInteger(value.level) || value.level < 0 || value.level > 100)
    )
      throw fault("audio_volume_invalid");
    if (value.action === "mute" && typeof value.muted !== "boolean")
      throw fault("audio_command_invalid");
    return {
      target: value.target,
      action: value.action,
      ...(value.action === "volume"
        ? { level: value.level }
        : value.action === "mute"
          ? { muted: value.muted }
          : {}),
    };
  }
  function apply(value, signal) {
    const command = validate(value);
    if (!available) throw fault("desktop_windows_required");
    if (pendingWrites >= 8) throw fault("audio_control_busy");
    pendingWrites++;
    const task = chain
      .catch(() => {})
      .then(async () => {
        if (closed || signal?.aborted) throw fault("control_deck_cancelled");
        epoch++;
        after = 0;
        try {
          return accept(await request("audio.set", command, signal));
        } catch (error) {
          state = {
            available: false,
            code: error.code || "audio_change_unconfirmed",
            output: null,
            input: null,
            devices: [],
            apps: [],
            updatedAt: now(),
          };
          throw error;
        }
      });
    const settled = task.finally(() => {
      pendingWrites--;
    });
    chain = settled;
    return settled;
  }
  function targetRow(target) {
    if (target === "system") return state.output;
    if (target === "microphone") return state.input;
    return [...state.devices, ...state.apps].find((item) => item.key === target);
  }
  function catalog() {
    const targets = [
      { key: "system", name: "System audio" },
      { key: "microphone", name: "Windows microphone" },
      ...seen.values(),
    ];
    return targets.flatMap((target) => {
      const actual = state.available && targetRow(target.key),
        known = !!actual;
      const feedback = {
        text: !known
          ? target.key.startsWith("app:")
            ? "No app audio session"
            : "Audio device unavailable"
          : actual.muted === true
            ? "Muted"
            : actual.volume === null
              ? "Mixed levels"
              : actual.volume + "%",
        tone: !known
          ? "unknown"
          : actual.muted === true
            ? "muted"
            : actual.mixed
              ? "mixed"
              : actual.volume === 0
                ? "inactive"
                : "ready",
        ...(known ? { value: actual.volume, muted: actual.muted } : {}),
      };
      const base = {
        group: target.key.startsWith("app:") ? "Windows app audio" : "Windows audio",
        available: available && known,
        defaults: {},
        state: feedback,
      };
      return [
        {
          ...base,
          id: "native.audio.volume:" + target.key,
          label: target.name + " volume",
          symbol: "\u25d5",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: { level: { type: "integer", minimum: 0, maximum: 100 } },
            required: ["level"],
          },
          defaults: { level: actual?.volume ?? 50 },
          control: { type: "slider", parameter: "level", min: 0, max: 100, step: 1 },
          description:
            "Set the Windows mixer level. App controls follow the application across restarts.",
        },
        {
          ...base,
          id: "native.audio.mute:" + target.key,
          label: (actual?.muted === true ? "Unmute " : "Mute ") + target.name,
          defaultTitle: target.name + " mute",
          symbol: actual?.muted === true ? "\uD83D\uDD07" : "\uD83D\uDD0A",
          defaultSymbol: "\uD83D\uDD0A",
          parameters: empty,
          description:
            "Toggle the current Windows mute state; microphone mute affects this Windows input device.",
        },
        {
          ...base,
          id: "native.audio.controls:" + target.key,
          label: target.name + " controls",
          symbol: "\u25d5",
          parameters: empty,
          kind: "navigation",
          navigation: { panel: "windows", target: target.key },
          description: "Open live controls for this Windows audio target.",
        },
      ];
    });
  }
  function execute(id, params, signal) {
    const match = /^native\.audio\.(volume|mute|controls):(.+)$/.exec(id);
    if (!match || !keyPattern.test(match[2])) throw fault("audio_command_invalid");
    if (match[1] === "controls") return { ok: true };
    return apply(
      {
        target: match[2],
        action: match[1] === "volume" ? "volume" : "toggle-mute",
        ...(match[1] === "volume" ? { level: params.level } : {}),
      },
      signal,
    );
  }
  return {
    read,
    snapshot,
    apply,
    catalog,
    execute,
    shutdown() {
      closed = true;
      epoch++;
    },
  };
};
