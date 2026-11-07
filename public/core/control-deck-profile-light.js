/** One recessed light per saved fixture; state feedback still overrides the palette. */
const painted = new WeakMap();
export function profileLightingFor(steps, catalog) {
  if (steps?.length !== 1) return null;
  const step = steps[0];
  const id =
    step.actionId === "lighting.profile" ? "lighting.profile:" + step.params?.id : step.actionId;
  return catalog.find((action) => action.id === id)?.profileLighting || null;
}
export function paintProfileLighting(tile, lights, enabled = true) {
  const source = tile.querySelector(".deckLedSource");
  if (!source) return;
  const palette = enabled && Array.isArray(lights) ? lights.slice(0, 256) : [];
  const signature = JSON.stringify(palette);
  if (painted.get(source) === signature) return;
  painted.set(source, signature);
  tile.dataset.profileLighting = String(palette.length > 0);
  tile.dataset.profileLeds = String(palette.length);
  if (!palette.length) {
    source.style.removeProperty("--profile-leds");
    tile.style.removeProperty("--deck-profile-color");
    return;
  }
  const images = palette.map((light, index) => {
    const angle = (index * Math.PI * 2) / palette.length + Math.PI / 2;
    const x = Math.round(50 + Math.cos(angle) * 34),
      y = Math.round(50 + Math.sin(angle) * 34);
    const color = /^#[a-f0-9]{6}$/i.test(light.color) ? light.color : "#ffffff";
    const alpha = Math.round(Math.max(0, Math.min(1, Number(light.level) || 0)) * 255)
      .toString(16)
      .padStart(2, "0");
    return `radial-gradient(circle at ${x}% ${y}%, ${color}${alpha} 0 9%, transparent 58%)`;
  });
  source.style.setProperty("--profile-leds", images.join(","));
  const channels = [0, 0, 0];
  let total = 0;
  for (const light of palette) {
    if (!/^#[a-f0-9]{6}$/i.test(light.color)) continue;
    const weight = Math.max(0, Math.min(1, Number(light.level) || 0));
    for (let i = 0; i < 3; i++)
      channels[i] += parseInt(light.color.slice(1 + i * 2, 3 + i * 2), 16) * weight;
    total += weight;
  }
  tile.style.setProperty(
    "--deck-profile-color",
    total
      ? "#" +
          channels
            .map((channel) =>
              Math.round(channel / total)
                .toString(16)
                .padStart(2, "0"),
            )
            .join("")
      : "#334155",
  );
}
