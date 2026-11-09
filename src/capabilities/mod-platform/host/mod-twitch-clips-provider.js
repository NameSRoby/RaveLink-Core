/** Explicit host capabilities. The broker checks consumes before dispatch. */
module.exports = function bindTwitchClips(registry, { getTwitchClips = () => null }) {
  const empty = (value) =>
    value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
  const response = (value) => value && typeof value === "object" && typeof value.ok === "boolean";
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
