/** Bounded color previews for UI LEDs; no device identifiers or output writes. */
module.exports = function fixtureLighting(fixtures, palette = ["#ffffff"]) {
  return fixtures.map((fixture, index) => {
    const colors = fixture.assignedPalette?.length ? fixture.assignedPalette : palette;
    return {
      color: colors[(fixture.colorSlot ?? index) % colors.length] || "#ffffff",
      level:
        fixture.raveBehavior === "off"
          ? 0
          : ["dim", "steady"].includes(fixture.raveBehavior)
            ? (fixture.sceneBrightness ?? 10) / 100
            : 1,
    };
  });
};
