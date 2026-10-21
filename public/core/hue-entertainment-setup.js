/** Entertainment setup uses saved bridge credentials without revealing them. */
(() => {
  const $ = (id) => document.getElementById(id);
  const ui = window.RaveLinkCoreUi;
  let selected = null,
    areas = [],
    generation = 0;
  const messages = {
    hue_entertainment_stop_lights_first:
      "Stop music lights, Rave or other active effects on these Hue lights before saving Entertainment settings.",
    hue_pairing_required: "Pair this Hue bridge first to store its credentials.",
    hue_entertainment_client_key_required:
      "A streaming client key is missing. Re-pair using the bridge link button, or enter your existing client key below.",
    invalid_hue_client_key: "The client key must contain exactly 32 hexadecimal characters.",
    invalid_hue_entertainment_area_id:
      "Enter a numeric Hue group ID or an Entertainment configuration UUID.",
    hue_area_discovery_failed:
      "Could not read areas from the bridge. Check its connection, try again, or enter an area ID manually.",
    hue_entertainment_area_membership_required:
      "Choose a discovered area containing this light before applying it to other lights.",
    hue_fixture_changed: "The fixture changed during setup. Edit it again before saving.",
  };
  function status(text) {
    $("hueEntertainmentStatus").textContent = text;
  }
  function selection() {
    const area = areas.find((a) => a.id === $("hueEntertainmentArea").value.trim());
    $("hueEntertainmentApply").disabled = !area?.includesFixture;
    if (!area?.includesFixture) $("hueEntertainmentApply").checked = false;
  }
  function error(cause) {
    status(
      messages[cause.message] ||
        "Entertainment setup could not be completed. Refresh the fixture and try again.",
    );
  }
  async function find() {
    if (!selected) return;
    const revision = generation,
      id = selected.id;
    $("findHueAreas").disabled = true;
    status("Finding Entertainment areas on this fixture’s bridge…");
    try {
      const result = await ui.request(`/fixtures/${encodeURIComponent(id)}/hue-entertainment`);
      if (revision !== generation) return;
      areas = result.areas;
      $("hueEntertainmentAreas").replaceChildren(
        ...areas.map((area) => {
          const option = document.createElement("option");
          option.value = area.id;
          option.label = `${area.name}${area.includesFixture ? " · includes this light" : " · other lights"}${area.active ? " · in use" : ""}`;
          return option;
        }),
      );
      const matching = areas.filter((a) => a.includesFixture);
      if (!$("hueEntertainmentArea").value && matching.length === 1)
        $("hueEntertainmentArea").value = matching[0].id;
      $("hueEntertainmentAreaNames").textContent = areas
        .map(
          (a) =>
            `${a.name} (${a.id})${a.includesFixture ? " — includes this light" : ""}${a.active ? " — currently in use" : ""}`,
        )
        .join("; ");
      const hint = !result.clientKeyConfigured
        ? " Streaming key missing: re-pair this bridge or enter your client key."
        : "";
      status(
        (areas.length
          ? `${areas.length} area${areas.length === 1 ? "" : "s"} found. Choose an area and save.`
          : "No areas found. Create an Entertainment area in the Hue app, then find areas again, or enter its ID.") +
          hint,
      );
      selection();
    } catch (cause) {
      if (revision === generation) error(cause);
    } finally {
      if (revision === generation) $("findHueAreas").disabled = false;
    }
  }
  function load(detail = null) {
    generation++;
    selected = detail?.brand === "hue" ? detail : null;
    areas = [];
    $("hueEntertainmentArea").value = selected?.entertainmentAreaId || "";
    $("hueEntertainmentKey").value = "";
    $("hueEntertainmentAreas").replaceChildren();
    $("hueEntertainmentAreaNames").textContent = "";
    $("hueEntertainmentApply").checked = false;
    $("hueEntertainmentApply").disabled = true;
    $("findHueAreas").disabled = !selected;
    $("saveHueEntertainment").disabled = !selected;
    $("hueEntertainmentKey").placeholder = selected?.clientKeyConfigured
      ? "Stored securely — leave blank to keep"
      : "Optional: existing 32-character client key";
    status(
      selected
        ? "Entertainment changes apply when you next start music lights or Rave."
        : "Edit a saved Hue fixture to find and configure its Entertainment area.",
    );
    if (selected) void find();
  }
  $("fixtureId").addEventListener("input", () => load());
  $("fixtureBrand").addEventListener("change", () => load());
  $("findHueAreas").onclick = find;
  $("hueEntertainmentArea").oninput = selection;
  $("saveHueEntertainment").onclick = async () => {
    if (!selected) return;
    const revision = generation;
    $("saveHueEntertainment").disabled = true;
    try {
      const areaId = $("hueEntertainmentArea").value.trim();
      const result = await ui.request(
        `/fixtures/${encodeURIComponent(selected.id)}/hue-entertainment`,
        {
          method: "PUT",
          body: JSON.stringify({
            areaId,
            clientKey: $("hueEntertainmentKey").value.trim(),
            applyToAreaLights: $("hueEntertainmentApply").checked,
          }),
        },
      );
      if (revision !== generation) return;
      $("hueEntertainmentKey").value = "";
      status(
        result.configured
          ? `Entertainment saved for ${result.updatedFixtureIds.length} light${result.updatedFixtureIds.length === 1 ? "" : "s"}. Start a new music lighting or Rave session to use it.`
          : "Entertainment area cleared. New sessions use standard Hue control.",
      );
      await ui.refreshFixtures();
    } catch (cause) {
      if (revision === generation) error(cause);
    } finally {
      if (revision === generation) $("saveHueEntertainment").disabled = false;
    }
  };
  window.RaveLinkHueSetup = { load };
  load();
})();
