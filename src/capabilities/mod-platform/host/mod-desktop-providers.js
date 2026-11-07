/** Explicit host capabilities. The broker checks consumes before dispatch. */
module.exports = function bindDesktopProviders(registry, { desktop, getTwitchClips = () => null }) {
  const empty = (value) =>
    value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
  const response = (value) => value && typeof value === "object" && typeof value.ok === "boolean";
  const discordMethods = ["status", "bind", "toggle", "deafenStatus", "toggleDeafen"];
  registry.registerCapabilityContract({
    capability: "discord.desktop.host.v1",
    methods: Object.fromEntries(
      discordMethods.map((method) => [
        method,
        { validateRequest: empty, validateResponse: response },
      ]),
    ),
  });
  registry.registerHostCapability({
    providerId: "ravelink.discord",
    capability: "discord.desktop.host.v1",
    invoke: async (_capability, method, _payload, options = {}) => {
      if (!desktop)
        return { ok: false, code: "discord_unavailable", available: false, muted: null };
      const simple = { status: "discordStatus", bind: "bindDiscord", toggle: "discordToggle" }[
        method
      ];
      const operation = {
        deafenStatus: "getdeafenstatus",
        toggleDeafen: "toggledeafen",
      }[method];
      if (options.signal?.aborted)
        throw Object.assign(Error("request_cancelled"), { code: "request_cancelled" });
      const value = simple
        ? await desktop[simple](
            ...(method === "status" ? [false, options.signal] : [options.signal]),
          )
        : await desktop.discordControl(operation, options.signal);
      return { ok: value?.ok !== false, ...value };
    },
  });
  registry.registerCapabilityContract({
    capability: "twitch.clips.host.v1",
    methods: {
      status: { validateRequest: empty, validateResponse: response },
      create: {
        validateRequest: (value) =>
          value &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          Object.keys(value).every((k) => ["title", "duration"].includes(k)) &&
          (value.title === undefined ||
            (typeof value.title === "string" && value.title.length <= 100)) &&
          (value.duration === undefined ||
            (Number.isFinite(value.duration) &&
              value.duration >= 5 &&
              value.duration <= 60 &&
              Math.abs(value.duration * 10 - Math.round(value.duration * 10)) < 1e-6)),
        validateResponse: response,
      },
    },
  });
  registry.registerHostCapability({
    providerId: "ravelink.twitch-clips",
    capability: "twitch.clips.host.v1",
    invoke: async (_capability, method, payload) => {
      const owner = getTwitchClips();
      if (!owner) return { ok: false, available: false, code: "twitch_integration_unavailable" };
      return method === "status" ? owner.status() : owner.create(payload);
    },
  });
};
