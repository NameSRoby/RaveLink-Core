import { deckId } from "./control-deck-id.js";
import { createWindowsPanel } from "./control-deck-windows-panel.js";
import { sliderIncrement } from "./control-deck-slider.js";
/** Compact live controls reuse the same owners as the overview and direct lights. */
export function createDeckPanels({ request, save, getConfig, getPageId, refresh, explain }) {
  const dialog = document.createElement("dialog");
  dialog.id = "deckControlPanel";
  dialog.className = "deckEditor deckControlPanel";
  dialog.setAttribute("aria-labelledby", "deckControlPanelTitle");
  dialog.innerHTML =
    '<div class="deckEditorHeading"><h2 id="deckControlPanelTitle">Quick controls</h2><button id="deckControlPanelClose" type="button">Close</button></div><p class="deckEditorNotice" role="status" aria-live="polite"></p><div class="deckPanelActions"><button id="deckControlPanelRefresh" type="button">Refresh</button></div><div class="deckPanelContent"></div>';
  document.body.append(dialog);
  const content = dialog.querySelector(".deckPanelContent"),
    notice = dialog.querySelector(".deckEditorNotice");
  let kind,
    busy = false,
    timer,
    reading = false;
  function node(tag, text, className) {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (className) el.className = className;
    return el;
  }
  function button(text, action) {
    const el = node("button", text);
    el.type = "button";
    el.onclick = action;
    return el;
  }
  async function work(action) {
    if (busy) return;
    busy = true;
    clearTimeout(timer);
    dialog.querySelectorAll("button,input,select").forEach((el) => (el.disabled = true));
    try {
      await action();
      await refresh();
    } catch (error) {
      notice.textContent = explain(error);
    } finally {
      busy = false;
      dialog.querySelectorAll("button,input,select").forEach((el) => (el.disabled = false));
      if (kind === "rewards" && dialog.open) await read();
    }
  }
  async function add(title, actionId, params, symbol, kind = "macro", appearance = {}) {
    const config = structuredClone(getConfig()),
      page = config.pages.find((p) => p.id === getPageId());
    if (!page || page.buttons.length >= 64)
      throw Error("This page is full. Add another page first.");
    page.buttons.push({
      id: deckId(),
      title,
      kind,
      steps: [{ actionId, params, delayMs: 0 }],
      appearance: { symbol, ...appearance },
    });
    await save(config);
    notice.textContent = "Button added to your deck. Use Edit to move or customize it.";
  }
  async function updateReward(purpose, paused, rewardId) {
    const result = await request("/api/dashboard/rewards", "POST", {
      purpose,
      paused,
      ...(rewardId ? { rewardId } : {}),
    });
    notice.textContent = result.partial
      ? result.results.some((r) => r.held)
        ? "Song rewards remain paused while request intake is closed. Other results are shown below."
        : "Some rewards could not update. Check their current state below."
      : paused
        ? "Rewards paused."
        : "Rewards resumed.";
  }
  function rewards(state) {
    content.replaceChildren();
    if (!state.available) {
      content.append(
        node(
          "p",
          "Connect Twitch with Channel Points permission to control rewards here.",
          "deckEditorHint",
        ),
      );
      return;
    }
    const rows = state.rewards || [],
      manageable = rows.filter((row) => row.manageable);
    if (!rows.length) {
      content.append(
        node("p", "Create a managed reward in Twitch Connection first.", "deckEditorHint"),
      );
      return;
    }
    const paused = manageable.length > 0 && manageable.every((row) => row.paused === true);
    const all = button(
      paused ? "Resume all rewards" : "Pause all rewards",
      () => void work(() => updateReward("all", !paused)),
    );
    all.id = "deckRewardsToggleAll";
    all.disabled = !manageable.length || manageable.some((row) => typeof row.paused !== "boolean");
    content.append(
      all,
      node(
        "p",
        "Control RaveLink-managed rewards below, or add individual toggles to your deck. Song rewards follow request-intake availability.",
        "deckEditorHint",
      ),
    );
    for (const row of rows) {
      const line = node("div", undefined, "deckRewardControl"),
        copy = node("div");
      copy.append(
        node("strong", row.title),
        node(
          "small",
          `${row.cost} points · ${row.paused === true ? "Paused" : row.paused === false ? "Available" : "State unknown"}`,
        ),
      );
      const toggle = button(
        row.paused ? "Resume" : "Pause",
        () => void work(() => updateReward(row.purpose, !row.paused, row.id)),
      );
      toggle.setAttribute("aria-label", (row.paused ? "Resume " : "Pause ") + row.title);
      toggle.disabled = !row.manageable || typeof row.paused !== "boolean";
      const pin = button(
        "+",
        () => void work(() => add(row.title, "rewards.toggle:" + row.id, {}, "\u23ef")),
      );
      pin.title = "Add a toggle for " + row.title;
      pin.setAttribute("aria-label", pin.title);
      pin.disabled = !row.manageable || !row.id;
      line.append(copy, toggle, pin);
      content.append(line);
    }
  }
  function lights(state) {
    content.replaceChildren(
      node(
        "p",
        "Set one light or the whole room. Apply sends a manual command and takes over the selected lights from any active effect.",
        "deckEditorHint",
      ),
    );
    const fixtures = (state.fixtures || []).filter((row) => row.enabled !== false);
    if (!fixtures.length) {
      content.append(node("p", "Add a fixture first under Fixtures.", "deckEditorHint"));
      return;
    }
    const scope = node("select"),
      color = node("input"),
      level = node("input"),
      output = node("output", "100%");
    scope.id = "deckLightScope";
    scope.add(new Option("All lights", "all"));
    fixtures.forEach((f) => scope.add(new Option(f.name || f.id, f.id)));
    color.id = "deckLightColor";
    color.type = "color";
    color.value = "#a90036";
    level.id = "deckLightLevel";
    level.type = "range";
    level.min = 0;
    level.max = 100;
    level.value = 100;
    level.oninput = () => (output.textContent = level.value + "%");
    for (const [title, input] of [
      ["Control", scope],
      ["Light color", color],
      ["Brightness", level],
    ]) {
      const label = node("label", title, "deckField");
      label.append(input);
      if (input === level) label.append(output);
      content.append(label);
    }
    const params = (brightness = Number(level.value)) => ({
      scope: scope.value === "all" ? "all" : "fixture",
      ...(scope.value === "all" ? {} : { fixtureId: scope.value }),
      color: color.value,
      brightness,
    });
    const apply = (brightness) =>
      work(async () => {
        const result = await request("/color", "POST", {
          text: `${color.value} ${brightness}%`,
          target: "both",
          ...(scope.value === "all" ? {} : { fixtureId: scope.value }),
        });
        if (result.ok === false || result.failed > 0 || result.result?.failed > 0)
          throw Error("Some lights could not update. Check their connection.");
        notice.textContent = "Manual light command sent.";
      });
    const actions = node("div", undefined, "deckPanelActions");
    actions.append(
      button("Apply", () => void apply(Number(level.value))),
      button("Turn off", () => void apply(0)),
      button(
        "+ Add this setting to deck",
        () =>
          void work(() =>
            add(
              scope.value === "all" ? "Set all lights" : scope.selectedOptions[0].textContent,
              "light.static",
              params(),
              "\u263c",
            ),
          ),
      ),
    );
    content.append(actions);
  }
  async function read() {
    clearTimeout(timer);
    if (reading || busy || !dialog.open) return;
    reading = true;
    try {
      const state = await request(kind === "rewards" ? "/api/dashboard/rewards" : "/fixtures");
      if (dialog.open) kind === "rewards" ? rewards(state) : lights(state);
    } catch (error) {
      notice.textContent = explain(error);
    } finally {
      reading = false;
      if (dialog.open && kind === "rewards") timer = setTimeout(() => void read(), 2000);
    }
  }
  dialog.querySelector("#deckControlPanelClose").onclick = () => dialog.close();
  dialog.querySelector("#deckControlPanelRefresh").onclick = () => void read();
  dialog.addEventListener("close", () => clearTimeout(timer));
  const windows = createWindowsPanel({
    request,
    add,
    explain,
    getSliderIncrement: () => sliderIncrement(getConfig()?.layout),
  });
  let obs;
  return {
    add,
    async open(type, options) {
      if (type === "obs") {
        obs ||= (await import("./control-deck-obs-panel.js")).createObsPanel({
          request,
          add,
          explain,
        });
        return obs.open();
      }
      if (type === "windows") return windows.open(options);
      if (!["rewards", "lights"].includes(type)) return;
      kind = type;
      notice.textContent = "";
      content.replaceChildren();
      dialog.querySelector("h2").textContent =
        type === "rewards" ? "Channel Points rewards" : "Light controls";
      dialog.showModal();
      await read();
    },
  };
}
