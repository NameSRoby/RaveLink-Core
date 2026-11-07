/** Music buttons read the existing session/library owners at every press. */
const { fault } = require("./control-deck-config");
const empty = { type: "object", additionalProperties: false, properties: {} };
const ids = [
  "music.start",
  "music.stop",
  "music.rave",
  "music.rave-toggle",
  "music.auto",
  "music.toggle",
  "music.auto-toggle",
];
const running = new Set(["running", "preview", "preheating", "acquiring", "waiting"]);
const resting = new Set(["idle", "stopped", "failed"]);
module.exports = function musicActions({ music }) {
  let chain = Promise.resolve();
  function inspect() {
    const view = music.view(),
      status = view.status || {},
      state = status.state;
    const installed = view.installed !== false;
    const known = installed && (running.has(state) || resting.has(state) || state === "stopping");
    const on = running.has(state),
      busy = state === "stopping";
    const ready = Boolean(
      installed &&
      view.captureAvailable &&
      status.sourceSelected &&
      status.permissions?.capture &&
      status.permissions?.output &&
      status.musicFixtureCount,
    );
    const autoKnown = installed && typeof view.autoRaveEnabled === "boolean";
    return {
      view,
      known,
      on,
      busy,
      ready,
      autoKnown,
      session: {
        text: !known
          ? "State unavailable"
          : busy
            ? "Stopping lights"
            : on
              ? state === "preview"
                ? "Preview running"
                : state === "running"
                  ? "Lights running"
                  : "Starting lights"
              : state === "failed"
                ? "Light session failed"
                : "Lights stopped",
        active: known && state === "running",
        tone: !known
          ? "unknown"
          : busy || (on && state !== "running" && state !== "preview")
            ? "pending"
            : state === "failed"
              ? "error"
              : on
                ? "active"
                : "inactive",
      },
      auto: {
        text: !autoKnown
          ? "State unavailable"
          : view.autoRaveEnabled
            ? "Auto-Rave on"
            : "Auto-Rave off",
        active: autoKnown && view.autoRaveEnabled,
        tone: !autoKnown ? "unknown" : view.autoRaveEnabled ? "active" : "inactive",
      },
    };
  }
  function catalog() {
    const current = inspect();
    const row = (id, label, symbol, available, extra = {}) => ({
      id,
      label,
      symbol,
      available,
      group: "Audio & lights",
      parameters: empty,
      defaults: {},
      description: label,
      ...extra,
    });
    return [
      row(
        "music.rave-toggle",
        current.on || current.busy ? "Stop Rave & restore" : "Start Rave · until restored",
        "\u03df",
        current.known &&
          !current.busy &&
          (current.on || (current.ready && current.view.design?.raveEnabled === true)),
        {
          defaultTitle: "Rave / restore",
          defaultSymbol: "\u03df",
          description:
            "Start music-reactive Rave until pressed again. Stop restores the previous light states. Uses your Music-to-Light fixture selection and profile settings.",
          state: current.session,
          profileLighting:
            current.view.rave?.lighting ||
            require("../../../integrations/music-to-light/fixture-lighting.cjs")(
              current.view.bindings?.fixtures || [],
              current.view.design?.palette,
            ),
        },
      ),
      row(
        "music.toggle",
        current.known
          ? current.on || current.busy
            ? "Stop lights & restore"
            : "Start music lights"
          : "Start / stop music lights",
        "\u23ef",
        current.known && !current.busy && (current.on || current.ready),
        { defaultTitle: "Music lights", defaultSymbol: "\u23ef", state: current.session },
      ),
      row(
        "music.auto-toggle",
        current.autoKnown
          ? current.view.autoRaveEnabled
            ? "Disable Auto-Rave"
            : "Enable Auto-Rave"
          : "Enable / disable Auto-Rave",
        "\u21bb",
        current.autoKnown,
        { defaultTitle: "Auto-Rave", defaultSymbol: "\u21bb", state: current.auto },
      ),
      row("music.start", "Start music lights", "\u25b6", current.ready && !current.busy, {
        state: current.session,
      }),
      row("music.stop", "Stop lights & restore", "\u25a0", current.known && !current.busy, {
        state: current.session,
      }),
      row(
        "music.rave",
        "Start Rave",
        "\u03df",
        current.ready && !current.busy && current.view.design?.raveEnabled === true,
      ),
      row("music.auto", "Set Auto-Rave", "\u21bb", current.autoKnown, {
        state: current.auto,
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: { enabled: { type: "boolean" } },
          required: ["enabled"],
        },
        defaults: { enabled: true },
      }),
    ];
  }
  const check = (signal) => {
    if (signal?.aborted) throw fault("control_deck_cancelled");
  };
  const call = (method, payload = null) =>
    music.call({ capability: "music.session.v1", method, payload });
  async function stop() {
    const result = await call("stop");
    if (result?.session?.failedOperations) throw fault("lighting_restore_failed");
    return result;
  }
  function execute(id, params, signal) {
    const pending = chain
      .catch(() => {})
      .then(() => {
        check(signal);
        if (id === "music.auto-toggle") {
          const current = inspect();
          if (!current.autoKnown) throw fault("music_auto_state_unknown");
          return music.songPolicy({ enabled: !current.view.autoRaveEnabled });
        }
        if (id === "music.toggle" || id === "music.rave-toggle") {
          const current = inspect();
          if (!current.known) throw fault("music_session_state_unknown");
          if (current.busy) throw fault("music_session_busy");
          if (current.on) return stop();
          if (!current.ready) throw fault("control_deck_action_unavailable");
          if (id === "music.rave-toggle") {
            if (current.view.design?.raveEnabled !== true)
              throw fault("control_deck_action_unavailable");
            return music.manualRave({ untilStopped: true });
          }
          return call("start", { mode: "live" });
        }
        if (id === "music.start") return call("start", { mode: "live" });
        if (id === "music.stop") return stop();
        if (id === "music.rave") return music.manualRave({});
        if (id === "music.auto") return music.songPolicy({ enabled: params.enabled });
        throw fault("control_deck_action_unavailable");
      });
    chain = pending;
    return pending;
  }
  return { catalog, execute, handles: (id) => ids.includes(id) };
};
