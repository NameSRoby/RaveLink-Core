/** Bundled button adapter. Discord state comes from the desktop owner; a click
 * never flips a local flag or assumes Discord accepted a shortcut. */
let host;
module.exports = {
  activate(context) {
    host = context;
  },
  async handleRequest({ method }) {
    if (!["toggle", "status", "bind", "deafenStatus", "toggleDeafen"].includes(method))
      throw Error("method_unavailable");
    const result = await host.callCapability(
      "discord.desktop.host.v1",
      method,
      {},
      { timeoutMs: 6000 },
    );
    const value = result?.value || result;
    const mode = /deafen/i.test(method) ? "deafened" : "muted";
    const state = value?.[mode],
      known = value?.available === true && typeof state === "boolean";
    const available = value?.available === true;
    const unavailableLabels = {
      discord_binding_required: "Bind Discord in Setup",
      discord_not_running: "Open Discord",
      discord_mute_button_not_found: "Discord control not visible",
      discord_accessibility_unavailable: "Discord control not visible",
      discord_deafen_absent: "Audio control not visible",
      desktop_action_timeout: "Discord took too long",
      control_deck_cancelled: "Retrying Discord connection",
    };
    const labels = {
      muted: ["Discord microphone on", "Discord muted"],
      deafened: ["Discord audio on", "Discord deafened"],
    };
    const tones = {
      muted: ["unmuted", "muted"],
      deafened: ["listening", "deafened"],
    };
    return {
      ...value,
      feedback: {
        state: known
          ? tones[mode][Number(state)]
          : value?.available === true
            ? "unknown"
            : "unavailable",
        label: known
          ? labels[mode][Number(state)]
          : unavailableLabels[value?.code] ||
            (value?.bound ? "Discord control not visible" : "Connect Discord in Setup"),
        active: known && state,
        available,
      },
    };
  },
};
