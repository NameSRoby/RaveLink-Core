/** Compact group selection and one fixture inspector; edits remain local drafts. */
const el = (tag, text, css) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (css) node.className = css;
  return node;
};
export function renderViewerGroups({ host, rules, fixtures, selected, choose, controls, move }) {
  const active = rules.find((rule) => rule.id === selected) || rules[0];
  if (!active) return;
  const navigation = el("div", undefined, "viewerGroupList");
  navigation.setAttribute("aria-label", "Fixture groups");
  for (const rule of rules) {
    const button = el("button", undefined, "viewerGroupChoice");
    button.type = "button";
    button.dataset.viewerGroup = rule.id;
    button.setAttribute("aria-pressed", String(rule === active));
    button.append(
      el("strong", rule.id === "active-fixtures" ? "No prefix" : rule.name),
      el(
        "small",
        `${rule.fixtureIds.length} light${rule.fixtureIds.length === 1 ? "" : "s"}${rule.enabled ? "" : " · Disabled"}`,
      ),
    );
    button.onclick = () => {
      choose(rule.id);
      host
        .querySelector(`[data-viewer-group="${CSS.escape(rule.id)}"]`)
        ?.focus({ preventScroll: true });
    };
    navigation.append(button);
  }
  const inspector = el("section", undefined, "viewerGroupEditor");
  inspector.append(
    el("h4", active.id === "active-fixtures" ? "No-prefix group" : active.name),
    controls(active, active.id === "active-fixtures"),
  );
  const list = el("div", undefined, "viewerFixtureList");
  for (const fixture of fixtures) {
    const owner = rules.find((rule) => rule.fixtureIds.includes(fixture.id));
    const row = el("label", undefined, "viewerFixtureRow"),
      input = el("input");
    input.type = "checkbox";
    input.checked = owner === active;
    input.dataset.viewerFixture = fixture.id;
    input.disabled = fixture.missing && !input.checked;
    input.onchange = () => {
      move(fixture.id, input.checked ? active.id : "available");
      host
        .querySelector(`[data-viewer-fixture="${CSS.escape(fixture.id)}"]`)
        ?.focus({ preventScroll: true });
    };
    const copy = el("span");
    copy.append(
      el("strong", fixture.name || fixture.id),
      el(
        "small",
        fixture.missing
          ? "Unavailable fixture"
          : owner && owner !== active
            ? `In ${owner.name}`
            : String(fixture.brand || "Light"),
      ),
    );
    row.append(input, copy);
    list.append(row);
  }
  if (!fixtures.length) list.append(el("p", "Add fixtures in Lights setup first.", "effectHelp"));
  inspector.append(el("p", "Select the lights this group can control.", "effectHelp"), list);
  host.replaceChildren(navigation, inspector);
}
