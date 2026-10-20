/** Operator-only fixture roles. No capture, timers, transport or scene state.
 * Keep per-fixture scene controls together, separate from the signal pipeline.
 */
(() => {
  function render({ view, $, labels }) {
    const selected = new Map(view.bindings.fixtures.map((f) => [f.id, f]));
    $("fixtureChoices").replaceChildren(
      ...view.fixtures.map((fixture, index) => {
        const binding = selected.get(fixture.id) || {},
          row = document.createElement("div");
        row.className = "musicFixture";
        row.dataset.fixtureId = fixture.id;
        const name = document.createElement("label");
        name.className = "musicCheck";
        const enabled = document.createElement("input");
        enabled.type = "checkbox";
        enabled.checked = selected.has(fixture.id);
        name.append(enabled, document.createTextNode(fixture.name + " · " + fixture.brand));
        row.append(name);
        const fields = {};
        function field(key, title, options, value, min, max, step) {
          const label = document.createElement("label");
          label.textContent = title;
          const input = document.createElement(options ? "select" : "input");
          input.dataset.routeField = key;
          input.setAttribute("aria-label", fixture.name + " " + title);
          if (options)
            for (const [v, text] of Object.entries(options)) input.add(new Option(text, v));
          else {
            input.type = "number";
            input.min = min;
            input.max = max;
            input.step = step ?? 1;
          }
          input.value = String(value);
          label.append(input);
          row.append(label);
          fields[key] = input;
          return input;
        }
        field("role", "Frequency role", labels, binding.role || ["low", "mid", "high"][index % 3]);
        field(
          "position",
          "Position (0–1)",
          null,
          binding.position ?? index / Math.max(1, view.fixtures.length - 1),
          0,
          1,
          0.1,
        );
        const behavior = field(
          "raveBehavior",
          "During music / Rave",
          {
            reactive: "React to music",
            dim: "Theatre: dim & hold",
            steady: "Hold a palette color",
            off: "Switch off",
          },
          binding.raveBehavior || "reactive",
        );
        field(
          "sceneBrightness",
          "Scene level (%)",
          null,
          binding.sceneBrightness ?? 10,
          fixture.brand === "wiz" ? 10 : 1,
          100,
        );
        field("sceneFadeMs", "Dim fade (ms)", null, binding.sceneFadeMs ?? 1500, 0, 10000, 100);
        field(
          "colorSlot",
          "Steady palette color",
          Object.fromEntries(Array.from({ length: 8 }, (_, i) => [i, "Color " + (i + 1)])),
          binding.colorSlot || 0,
        );
        function update() {
          fields.sceneBrightness.parentElement.firstChild.textContent =
            behavior.value === "dim" ? "Dim to at most (%)" : "Scene level (%)";
          fields.sceneBrightness.parentElement.hidden = !["dim", "steady"].includes(behavior.value);
          fields.sceneFadeMs.parentElement.hidden = behavior.value !== "dim";
          fields.colorSlot.parentElement.hidden = behavior.value !== "steady";
        }
        behavior.onchange = update;
        update();
        return row;
      }),
    );
    if (!view.fixtures.length)
      $("fixtureChoices").textContent = "No enabled Hue or WiZ lights. Add them in Fixtures first.";
  }
  function read($) {
    return [...$("fixtureChoices").querySelectorAll(".musicFixture")]
      .filter((row) => row.querySelector('input[type="checkbox"]').checked)
      .map((row) => ({
        id: row.dataset.fixtureId,
        ...Object.fromEntries(
          [...row.querySelectorAll("[data-route-field]")].map((input) => [
            input.dataset.routeField,
            ["position", "sceneBrightness", "sceneFadeMs", "colorSlot"].includes(
              input.dataset.routeField,
            )
              ? Number(input.value)
              : input.value,
          ]),
        ),
      }));
  }
  globalThis.RaveLinkMusicFixtures = Object.freeze({ render, read });
})();
