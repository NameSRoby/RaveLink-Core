/** Preview dashboard preferences, then save them locally. Editing never runs live actions. */
import { selectMainTab } from "./feature-navigation.js";
const copy = (value) => structuredClone(value);
export function initDashboardLayout(panel) {
  const grid = panel.querySelector(".dashboardGrid");
  let catalog = [],
    saved,
    draft,
    saving = false;
  const gear = document.createElement("button");
  gear.type = "button";
  gear.id = "dashboardEditToggle";
  gear.textContent = "Edit dashboard";
  gear.setAttribute("aria-pressed", "false");
  gear.disabled = true;
  document.getElementById("themePanel").append(gear);
  const toolbar = document.createElement("div");
  toolbar.className = "dashboardEditBar";
  toolbar.innerHTML =
    '<button id="dashboardEdit" type="button" aria-pressed="false" disabled>Edit dashboard</button><div id="dashboardEditTools" hidden><button id="dashboardAdd" type="button">Add / remove sections &amp; actions</button><button id="dashboardReset" type="button">Reset layout</button><button id="dashboardCancel" type="button">Cancel editing</button></div><span id="dashboardEditNotice" role="status"></span>';
  panel.querySelector(".dashboardHero").after(toolbar);
  const $ = (id) => document.getElementById("dashboard" + id);
  const dialog = document.createElement("dialog");
  dialog.id = "dashboardCatalog";
  dialog.innerHTML =
    '<h2>Your dashboard catalog</h2><p>Choose sections and the quick actions inside each one. Options remain available here even when their package is not installed.</p><label>Find a section or action<input id="dashboardCatalogSearch" type="search" placeholder="Search rewards, Rave, profiles…" /></label><div class="dashboardLayoutOptions"><label>Spacing<select id="dashboardDensity"><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></label><label>Columns<select id="dashboardColumns"><option value="auto">Automatic</option><option value="one">One column</option><option value="two">Two columns</option></select></label></div><div id="dashboardCatalogChoices"></div><p>These are layout preferences. They do not grant permissions, install packages or change live output.</p><button id="dashboardCatalogDone" type="button">Back to dashboard preview</button>';
  document.body.append(dialog);
  function notice(text, error = false) {
    $("EditNotice").textContent = text;
    $("EditNotice").dataset.error = String(error);
  }
  function move(id, direction) {
    if (saving) return;
    const index = draft.widgets.indexOf(id),
      target = index + direction;
    if (index < 0 || target < 0 || target >= draft.widgets.length) return;
    [draft.widgets[index], draft.widgets[target]] = [draft.widgets[target], draft.widgets[index]];
    apply();
    grid.querySelector(`[data-dashboard-widget="${id}"] .dashboardEditTools button`)?.focus();
  }
  function apply() {
    const layout = draft || saved;
    if (!layout) return;
    panel.dataset.editing = String(Boolean(draft));
    panel.dataset.density = layout.density;
    panel.dataset.columns = layout.columns;
    for (const widget of catalog) {
      const card = grid.querySelector(`[data-dashboard-widget="${widget.id}"]`);
      if (!card) continue;
      card.hidden = !layout.widgets.includes(widget.id);
      let tools = card.querySelector(".dashboardEditTools");
      if (!tools) {
        tools = document.createElement("div");
        tools.className = "dashboardEditTools";
        for (const [label, handler] of [
          ["Move up", () => move(widget.id, -1)],
          ["Move down", () => move(widget.id, 1)],
          [
            "Remove",
            () => {
              draft.widgets = draft.widgets.filter((id) => id !== widget.id);
              apply();
            },
          ],
        ]) {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = label;
          button.setAttribute("aria-label", `${label}: ${widget.title}`);
          button.onclick = () => {
            if (!saving) handler();
          };
          tools.append(button);
        }
        card.prepend(tools);
      }
      tools.hidden = !draft;
      const index = layout.widgets.indexOf(widget.id);
      tools.children[0].disabled = index === 0;
      tools.children[1].disabled = index === layout.widgets.length - 1;
      for (const action of widget.actions)
        card
          .querySelectorAll(action.selector)
          .forEach((node) => (node.hidden = layout.hiddenActions.includes(action.id)));
    }
    const order = [
      ...layout.widgets,
      ...catalog.map((row) => row.id).filter((id) => !layout.widgets.includes(id)),
    ];
    order.forEach((id, index) => {
      const card = grid.querySelector(`[data-dashboard-widget="${id}"]`);
      if (card && grid.children[index] !== card)
        grid.insertBefore(card, grid.children[index] || null);
    });
    $("Empty").hidden = layout.widgets.length > 0;
    $("EditTools").hidden = !draft;
    gear.setAttribute("aria-pressed", String(Boolean(draft)));
    $("Edit").setAttribute("aria-pressed", String(Boolean(draft)));
    gear.textContent = $("Edit").textContent = draft ? "Save & finish editing" : "Edit dashboard";
  }
  function drawCatalog() {
    const query = $("CatalogSearch").value.trim().toLowerCase(),
      host = $("CatalogChoices");
    host.replaceChildren();
    for (const widget of catalog) {
      const matchesGroup = `${widget.title} ${widget.description}`.toLowerCase().includes(query);
      const actions = widget.actions.filter(
        (action) => matchesGroup || action.label.toLowerCase().includes(query),
      );
      if (!actions.length) continue;
      const section = document.createElement("section"),
        label = document.createElement("label"),
        toggle = document.createElement("input"),
        heading = document.createElement("strong"),
        help = document.createElement("p");
      section.className = "dashboardCatalogSection";
      label.className = "dashboardCatalogChoice";
      toggle.type = "checkbox";
      toggle.dataset.widget = widget.id;
      toggle.checked = draft.widgets.includes(widget.id);
      toggle.onchange = () => {
        draft.widgets = toggle.checked
          ? [...draft.widgets, widget.id]
          : draft.widgets.filter((id) => id !== widget.id);
        apply();
      };
      heading.textContent = widget.title;
      help.textContent = `${widget.description} Requires: ${widget.requires}.`;
      label.append(toggle, heading);
      section.append(label, help);
      const choices = document.createElement("div");
      choices.className = "dashboardCatalogActions";
      for (const action of actions) {
        const row = document.createElement("label"),
          input = document.createElement("input");
        row.className = "dashboardCatalogChoice";
        input.type = "checkbox";
        input.dataset.action = action.id;
        input.checked = !draft.hiddenActions.includes(action.id);
        input.onchange = () => {
          draft.hiddenActions = input.checked
            ? draft.hiddenActions.filter((id) => id !== action.id)
            : [...draft.hiddenActions, action.id];
          apply();
        };
        row.append(input, document.createTextNode(action.label));
        choices.append(row);
      }
      section.append(choices);
      host.append(section);
    }
    if (!host.children.length) host.textContent = "No matching sections or actions.";
    $("Density").value = draft.density;
    $("Columns").value = draft.columns;
  }
  async function toggle() {
    if (!saved || saving) return;
    if (!draft) {
      draft = copy(saved);
      selectMainTab("dashboard");
      document.getElementById("closeTheme").click();
      notice(
        "Preview mode: add, remove or reorder controls. Live actions are disabled while editing.",
      );
      apply();
      return;
    }
    saving = true;
    panel.dataset.layoutSaving = "true";
    gear.disabled = $("Edit").disabled = true;
    try {
      const response = await fetch("/api/presentation/dashboard", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ layout: draft }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw Error("save_failed");
      saved = result.layout;
      draft = null;
      apply();
      notice("Dashboard layout saved.");
    } catch {
      notice(
        "Layout could not save. Your preview is still open; try saving again or cancel.",
        true,
      );
    } finally {
      saving = false;
      panel.dataset.layoutSaving = "false";
      gear.disabled = $("Edit").disabled = false;
    }
  }
  gear.onclick = $("Edit").onclick = toggle;
  $("Add").onclick = () => {
    if (saving) return;
    drawCatalog();
    dialog.showModal();
  };
  $("Cancel").onclick = () => {
    if (saving) return;
    draft = null;
    apply();
    notice("Layout changes discarded.");
  };
  $("Reset").onclick = () => {
    if (saving) return;
    draft = {
      widgets: catalog.filter((w) => w.default).map((w) => w.id),
      hiddenActions: [],
      density: "comfortable",
      columns: "auto",
    };
    apply();
    notice("Default layout previewed. Save to keep it, or cancel.");
  };
  $("CatalogSearch").oninput = drawCatalog;
  $("CatalogDone").onclick = () => dialog.close();
  $("Density").onchange = () => {
    draft.density = $("Density").value;
    apply();
  };
  $("Columns").onchange = () => {
    draft.columns = $("Columns").value;
    apply();
  };
  panel.addEventListener(
    "click",
    (event) => {
      if (
        draft &&
        event.target.closest(".dashboardCard") &&
        !event.target.closest(".dashboardEditTools")
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true,
  );
  void fetch("/api/presentation/dashboard", { cache: "no-store" })
    .then(async (response) => {
      const result = await response.json();
      if (!response.ok || !result.ok) throw Error("load_failed");
      catalog = result.catalog;
      saved = result.layout;
      apply();
      gear.disabled = $("Edit").disabled = false;
    })
    .catch(() =>
      notice(
        "Dashboard layout settings could not load. Restart Core after updating, then refresh.",
        true,
      ),
    );
  return { apply };
}
