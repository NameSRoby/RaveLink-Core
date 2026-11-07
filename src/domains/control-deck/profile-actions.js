/** Profiles are discovered from the current installation; no fixture bindings ship here. */
module.exports = function profileActions(profiles) {
  return profiles.map((profile) => ({
    id: "lighting.profile:" + profile.id,
    label: profile.name,
    defaultTitle: profile.name,
    symbol: "💡",
    group: "Light profiles",
    available: Object.keys(profile.fixtureTargets).length > 0,
    description: `Apply ${profile.name}. Uses this profile's saved fixtures and settings.`,
    parameters: { type: "object", additionalProperties: false, properties: {} },
    defaults: {},
    profileLighting: Object.values(profile.fixtureTargets).map((fixtureTarget) => {
      const target = profile.strategy === "shared" ? profile.sharedTarget : fixtureTarget;
      const mix = Math.max(0, Math.min(1, (target.temperatureKelvin - 2000) / 4500));
      const warm = [255, 205, 140],
        cool = [215, 232, 255];
      const white =
        "#" +
        warm
          .map((v, i) =>
            Math.round(v + (cool[i] - v) * mix)
              .toString(16)
              .padStart(2, "0"),
          )
          .join("");
      return {
        color: target.mode === "temperature" ? white : target.color,
        level: target.on === false ? 0 : target.brightness / 100,
      };
    }),
  }));
};
