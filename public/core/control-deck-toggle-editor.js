/** Both toggle states are local drafts; editing never invokes an action. */
export function createToggleStates({ node, field, input, value, symbol }) {
  const element = node("section", "deckToggleStates"),
    controls = {};
  element.append(
    node("h3", "", "Toggle appearance"),
    node(
      "p",
      "deckFieldHelp",
      "Tracks successful button presses. External changes are not detected; restarting Core resets to the first press.",
    ),
  );
  const grid = node("div", "deckToggleStateGrid");
  for (const [key, heading, color] of [
    ["off", "Initial / after second press", "#8190a8"],
    ["on", "After first press", "#27c58a"],
  ]) {
    const card = node("section", "deckToggleStateCard"),
      saved = value?.[key];
    card.append(node("h4", "", heading));
    const label = input("text", saved?.label || (key === "off" ? "Off" : "On"), 80),
      icon = input("text", saved?.symbol || symbol, 64),
      led = input("color", saved?.color || color);
    label.id = "deckToggle" + key + "Label";
    icon.id = "deckToggle" + key + "Symbol";
    led.id = "deckToggle" + key + "Color";
    const preview = node("div", "deckAppearancePreview deckButton");
    preview.style.setProperty("--deck-master-backlight", "1");
    const glyph = node("span", "deckButtonSymbol"),
      title = node("strong", "deckButtonTitle");
    preview.append(node("span", "deckLedSource"), node("span", "deckAcrylicFace"), glyph, title);
    const paint = () => {
      glyph.textContent = icon.value;
      title.textContent = label.value;
      preview.style.setProperty("--deck-color", led.value);
    };
    for (const control of [label, icon, led]) control.addEventListener("input", paint);
    paint();
    card.append(
      preview,
      field("State label", label),
      field("State icon / emoji", icon),
      field("LED color", led),
    );
    grid.append(card);
    controls[key] = { label, icon, led };
  }
  element.append(grid);
  return {
    element,
    read: () =>
      Object.fromEntries(
        Object.entries(controls).map(([key, c]) => [
          key,
          { label: c.label.value.trim(), symbol: c.icon.value, color: c.led.value },
        ]),
      ),
  };
}
