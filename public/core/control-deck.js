/** Dashboard button mode. Execution, permissions and macro state belong to Core.
 * Editing and page navigation never trigger an action. Poll only the visible deck.
 */
import { createDeckReorder } from "./control-deck-reorder.js";
import { profileLightingFor, paintProfileLighting } from "./control-deck-profile-light.js";
import { createDeckFeed } from "./control-deck-feed.js";
import { createDeckWidgets } from "./control-deck-widgets.js";
import { applyDeckLayout, createDeckLayout } from "./control-deck-layout.js";
import { createDeckFullscreen } from "./control-deck-fullscreen.js";
import { createDeckPager } from "./control-deck-pager.js";
import { installDeckKeys } from "./control-deck-keys.js";
import { createDeckAudioUi } from "./control-deck-audio-ui.js";
import { appendDeckSlider, sliderControl } from "./control-deck-slider.js";
import { placeDeckSliders } from "./control-deck-slider-layout.js";
import { createDeckSettings } from "./control-deck-settings.js";
import { createDeckPanels } from "./control-deck-panels.js";
import { deckIndicator } from "./control-deck-feedback.js";
import { createDeckDisplay } from "./control-deck-display.js";
import { createDeckEditor } from "./control-deck-editor.js";
import { createDeckIntegrations } from "./control-deck-integrations.js";
import { openFeaturePage, selectMainTab } from "./feature-navigation.js";
export function initControlDeck(panel, onOverview = () => {}) {
  let snapshot,
    catalog = [],
    editing = false,
    pageId = "",
    statusConnected = true,
    saving = false,
    closed = false,
    undoLayout = null,
    suppressClickUntil = 0;
  const pending = new Set(),
    holds = new Map();
  let receiptTimer,
    receiptDeadline = Infinity;
  function expireReceipt(at) {
    if (!Number.isFinite(at) || at >= receiptDeadline) return;
    clearTimeout(receiptTimer);
    receiptDeadline = at;
    receiptTimer = setTimeout(
      () => {
        receiptDeadline = Infinity;
        if (snapshot && !closed && isVisible()) updateStates();
      },
      Math.max(1, at - Date.now() + 10),
    );
  }
  const original = {
    title: panel.querySelector("h2").textContent,
    help: panel.querySelector(".dashboardHero p").textContent,
  };
  const node = (tag, className, text) => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  };
  const mode = node("div", "deckModeSwitch");
  mode.setAttribute("role", "group");
  mode.setAttribute("aria-label", "Dashboard mode");
  const overview = node("button", "", "Overview"),
    buttons = node("button", "", "Button deck");
  overview.type = buttons.type = "button";
  overview.id = "deckOverviewMode";
  buttons.id = "deckButtonMode";
  mode.append(overview, buttons);
  panel.querySelector(".dashboardHeroActions").prepend(mode);
  const host = node("section", "controlDeck");
  host.id = "controlDeck";
  host.hidden = true;
  host.setAttribute("aria-label", "Button deck");
  host.innerHTML =
    '<div class="deckToolbar"><nav id="deckPages" aria-label="Button pages"></nav><div class="deckTools"><button id="deckNewPage" type="button" title="Create another page of buttons">+ Page</button><button id="deckEdit" type="button" aria-pressed="false">Edit buttons</button><button id="deckCancelRuns" type="button" hidden>Stop running actions</button></div></div><p id="deckNotice" class="deckNotice" role="status" aria-live="polite"></p><div id="deckGrid" class="deckGrid" role="group" aria-label="Control buttons"></div><div class="deckFooter"><span id="deckHelp">Tap a button to run it. Hold a button for its optional second action.</span><button id="deckLayout" type="button">Layout</button><button id="deckPageSettings" type="button">Page settings</button></div>';
  panel.querySelector(".dashboardGrid").after(host);
  const colorStyle = node("style");
  host.append(colorStyle);
  const colorAnimation = (id) =>
    "deckCycle" +
    Array.from(id)
      .map((c) => c.codePointAt(0).toString(16))
      .join("_");
  const $ = (id) => document.getElementById("deck" + id);
  const workspace = node("div", "deckWorkspace"),
    rack = node("aside", "deckSliderRack");
  rack.id = "deckSliderRack";
  rack.setAttribute("aria-label", "Volume controls");
  $("Grid").before(workspace);
  workspace.append($("Grid"), rack);
  const widgets = createDeckWidgets({
    host,
    request,
    save,
    getConfig: () => snapshot?.config,
    visible: () => isVisible(),
    refresh: () => refresh(true),
    explain: (error) => explain(error),
    openTwitch: () => openFeaturePage("twitch-integration", "connection"),
    openObs: () => panels.open("obs"),
  });
  host.querySelector(".deckTools").append($("Layout"), $("PageSettings"));
  function note(text, error = false) {
    $("Notice").textContent = text;
    $("Notice").dataset.error = String(error);
  }
  async function request(url, method = "GET", body, raw = false) {
    const response = await fetch(url, {
      method,
      cache: "no-store",
      headers:
        body && !raw
          ? { "content-type": "application/json" }
          : raw
            ? { "content-type": body.type }
            : {},
      body: body ? (raw ? body : JSON.stringify(body)) : undefined,
    });
    const result = await response.json();
    if (!response.ok || result.ok === false)
      throw Error(result.error?.code || result.error || "deck_request_failed");
    return Object.hasOwn(result, "value") ? result.value : result;
  }
  const errors = {
    control_deck_revision_conflict:
      "This deck changed in another window. Reload its current settings and try again.",
    deck_revision_conflict:
      "This deck changed in another window. Reload its current settings and try again.",
    control_deck_action_unavailable:
      "This action is unavailable. Check its package, permissions or connection.",
    control_deck_busy: "This button is already running. Wait for it or stop the running action.",
  };
  const explain = (error) => errors[error.message] || String(error.message).replaceAll("_", " ");
  async function save(config, remember = true) {
    config = placeDeckSliders(config);
    if (saving) throw Error("Deck settings are still saving.");
    saving = true;
    mode.querySelectorAll("button").forEach((b) => (b.disabled = true));
    const previous = structuredClone(snapshot.config);
    try {
      snapshot = await request("/api/control-deck", "PUT", {
        value: config,
        revision: snapshot.revision,
      });
      undoLayout = remember ? { revision: snapshot.revision, config: previous } : null;
      render();
      return snapshot;
    } catch (error) {
      await refresh(true);
      throw error;
    } finally {
      saving = false;
      mode.querySelectorAll("button").forEach((b) => (b.disabled = false));
    }
  }
  const editor = createDeckEditor({
    onObsSetup: () => panels.open("obs"),
    request,
    save,
    getConfig: () => snapshot.config,
    getCatalog: () => catalog,
    onPage: (id) => {
      pageId = id;
      render();
    },
    note,
  });
  const layout = createDeckLayout({
    host,
    getConfig: () => snapshot.config,
    save,
    explain,
    request,
  });
  const settings = createDeckSettings({
    getConfig: () => snapshot.config,
    getPageId: () => pageId,
    save,
    editor,
    explain,
  });
  const settingsButton = node("button", "deckQuietButton", "Button settings");
  settingsButton.id = "deckSettingsOpen";
  settingsButton.type = "button";
  settingsButton.onclick = () => settings.open();
  host.querySelector(".deckTools").append(settingsButton);
  const panels = createDeckPanels({
    request,
    save,
    getConfig: () => snapshot.config,
    getPageId: () => pageId,
    refresh: () => refresh(true),
    explain,
  });
  const audioUi = createDeckAudioUi({
    host,
    workspace,
    rack,
    request,
    add: panels.add,
    explain,
    isVisible,
    getSnapshot: () => snapshot,
    getCatalog: () => catalog,
    getPageId: () => pageId,
    save,
    note,
  });
  const obsSetup = node("button", "deckQuietButton", "OBS connection");
  obsSetup.id = "deckObsSetup";
  obsSetup.type = "button";
  obsSetup.title = "Connect OBS or manage your scene, source and filter buttons";
  obsSetup.onclick = () => void panels.open("obs");
  panel.querySelector(".dashboardHeroActions").append(obsSetup);
  const integrations = createDeckIntegrations({
    request,
    refresh: () => refresh(true),
    onTwitchSetup: () => openFeaturePage("twitch-integration", "connection"),
  });
  const setup = node("button", "", "Connections");
  setup.id = "deckSetup";
  setup.type = "button";
  setup.onclick = () => void integrations.open();
  host.querySelector(".deckTools").prepend(setup);
  const focus = node("button", "deckQuietButton", "Focus view");
  focus.id = "deckFocus";
  focus.type = "button";
  focus.setAttribute("aria-pressed", "false");
  const fullscreen = createDeckFullscreen({
    host,
    button: focus,
    onEnter: () => {
      editing = false;
      render();
    },
  });
  host.querySelector(".deckTools").append(focus);
  const pager = createDeckPager({
    host,
    getConfig: () => snapshot?.config,
    getPageId: () => pageId,
    onPage: (id) => {
      pageId = id;
      render();
    },
    onSwipe: () => {
      holds.forEach(clearTimeout);
      holds.clear();
    },
  });
  installDeckKeys({ host, getConfig: () => snapshot?.config, isEditing: () => editing, pager });
  const undo = node("button", "deckQuietButton", "Undo");
  undo.id = "deckUndo";
  undo.type = "button";
  undo.hidden = true;
  undo.onclick = () => {
    if (undoLayout?.revision === snapshot.revision)
      void save(undoLayout.config, false)
        .then(() => note("Layout change undone."))
        .catch((e) => note(explain(e), true));
  };
  host.querySelector(".deckTools").append(undo);
  const display = createDeckDisplay(host),
    quick = node("div", "deckQuickOptions");
  const quickDisplay = node("select"),
    quickColumns = node("select"),
    columnsLabel = node("span");
  quickDisplay.id = "deckQuickDisplay";
  quickColumns.id = "deckQuickColumns";
  for (const [value, title] of [
    ["auto", "Auto fit"],
    ["image-text", "Icon + text"],
    ["image", "Icon / image only"],
    ["text", "Text only"],
    ["alternate", "Alternate icon / text"],
    ["per-button", "Each button’s setting"],
  ])
    quickDisplay.add(new Option(title, value));
  for (let count = 1; count <= 12; count++)
    quickColumns.add(new Option(String(count), String(count)));
  const displayLabel = node("label", "", "Display "),
    rowsLabel = node("label");
  displayLabel.append(quickDisplay);
  rowsLabel.append(columnsLabel, quickColumns);
  quick.append(displayLabel, rowsLabel);
  host.querySelector(".deckToolbar").append(quick);
  function quickSize() {
    return innerWidth <= 600 ? "phoneColumns" : innerWidth <= 1100 ? "tabletColumns" : "columns";
  }
  function syncQuickOptions() {
    if (!snapshot) return;
    const size = quickSize();
    quick.hidden = !editing;
    quickDisplay.value = snapshot.config.layout.display || "auto";
    quickColumns.value = String(
      size === "columns" ? snapshot.config.columns : snapshot.config.layout[size],
    );
    columnsLabel.textContent =
      (size === "columns" ? "Desktop" : size === "phoneColumns" ? "Phone" : "Tablet") +
      " buttons per row ";
  }
  async function saveQuickOptions() {
    if (saving) return;
    const config = structuredClone(snapshot.config),
      size = quickSize();
    config.layout.display = quickDisplay.value;
    const target = size === "columns" ? config : config.layout;
    target[size] = Number(quickColumns.value);
    quickDisplay.disabled = quickColumns.disabled = true;
    try {
      await save(config);
      note("Display and row count saved.");
    } catch (error) {
      note(explain(error), true);
    } finally {
      quickDisplay.disabled = quickColumns.disabled = false;
      syncQuickOptions();
    }
  }
  quickDisplay.onchange = quickColumns.onchange = () => void saveQuickOptions();
  addEventListener("resize", syncQuickOptions);
  function moveButton(buttonId, targetId, keyboard = false) {
    const config = structuredClone(snapshot.config),
      page = config.pages.find((p) => p.id === pageId),
      from = page.buttons.findIndex((b) => b.id === buttonId);
    if (from < 0 || buttonId === targetId) return;
    const [button] = page.buttons.splice(from, 1),
      at = page.buttons.findIndex((b) => b.id === targetId);
    page.buttons.splice(at < 0 ? page.buttons.length : at, 0, button);
    void save(config)
      .then(() => {
        note("Button moved. Undo is available.");
        if (keyboard)
          Array.from(host.querySelectorAll(".deckDragHandle"))
            .find((el) => el.dataset.buttonId === buttonId)
            ?.focus();
      })
      .catch((e) => note(explain(e), true));
  }
  const reorder = createDeckReorder({
    host,
    enabled: () => editing && !saving,
    moveButton,
    note,
    suppressClick: () => {
      suppressClickUntil = Date.now() + 300;
    },
  });
  async function changeMode(value) {
    if (!snapshot || saving) return;
    try {
      await save({ ...snapshot.config, mode: value });
      note("");
      if (value === "overview") onOverview();
      else void refresh();
    } catch (error) {
      note(explain(error), true);
    }
  }
  overview.onclick = () => void changeMode("overview");
  buttons.onclick = () => void changeMode("deck");
  function isVisible() {
    return (
      snapshot?.config.mode === "deck" &&
      panel.classList.contains("active") &&
      !document.hidden &&
      !closed
    );
  }
  function available(button) {
    return (
      button.kind === "folder" ||
      (button.steps || []).every((step) => {
        const action = catalog.find((a) => a.id === step.actionId);
        return !!action && action.available !== false;
      })
    );
  }
  function appearance(tile, button) {
    const a = button.appearance || {};
    const led = node("span", "deckLedSource"),
      face = node("span", "deckAcrylicFace");
    led.setAttribute("aria-hidden", "true");
    face.setAttribute("aria-hidden", "true");
    tile.append(led, face);
    tile.style.setProperty("--deck-color", a.color || "#a90036");
    tile.style.setProperty("--deck-text", a.textColor || "#ffffff");
    tile.style.setProperty("--deck-backlight", (a.backlight ?? 65) / 100);
    const colors = a.cycleColors || [];
    tile.dataset.cycling = String(colors.length > 1);
    if (colors.length > 1) tile.style.animationName = colorAnimation(button.id);
    tile.style.setProperty("--deck-cycle-a", colors[0] || a.color || "#a90036");
    tile.style.setProperty("--deck-cycle-b", colors[1] || colors[0] || a.color || "#a90036");
    tile.style.setProperty("--deck-cycle-c", colors[2] || colors[0] || a.color || "#a90036");
    tile.style.setProperty("--deck-cycle-time", (a.cycleMs || 6000) + "ms");
    tile.dataset.textMode = a.textMode || "image-text";
    if (a.imageId) {
      const img = node("img", "deckButtonImage");
      img.alt = "";
      img.draggable = false;
      img.src = "/api/control-deck/media/" + encodeURIComponent(a.imageId);
      tile.append(img);
    } else if (a.textMode !== "text")
      tile.append(
        node("span", "deckButtonSymbol", a.symbol || (button.kind === "folder" ? "▦" : "◆")),
      );
    tile.append(node("span", "deckButtonTitle", button.title));
  }
  function paintState(tile, button) {
    const running = snapshot.running?.find((r) => r.buttonId === button.id),
      state = snapshot.states?.[button.id];
    const indicator = deckIndicator({
      button,
      catalog,
      running,
      pending: pending.has(button.id),
      state,
      stale: !statusConnected,
    });
    tile.dataset.ledState = indicator.tone;
    expireReceipt(indicator.expiresAt);
    paintProfileLighting(
      tile,
      profileLightingFor(button.steps, catalog),
      button.appearance.profileBacklight !== "custom" && !button.toggleStates,
    );
    if (indicator.color) tile.style.setProperty("--deck-led-color", indicator.color);
    else tile.style.removeProperty("--deck-led-color");
    const action = catalog.find((a) => a.id === button.steps?.[0]?.actionId),
      feedback =
        button.steps?.length === 1 && !button.alternateSteps?.length ? action?.state : null;
    const toggleFace =
      button.alternateSteps?.length && button.toggleStates?.[state?.toggled ? "on" : "off"];
    if (toggleFace && !editing) {
      tile.querySelector(".deckButtonTitle").textContent = toggleFace.label;
      tile.setAttribute("aria-label", toggleFace.label);
      if (!button.appearance.imageId) {
        const symbol = tile.querySelector(".deckButtonSymbol");
        if (symbol) symbol.textContent = toggleFace.symbol || button.appearance.symbol;
      }
    } else if (
      action?.defaultTitle &&
      button.title === action.defaultTitle &&
      action?.label &&
      !editing
    ) {
      tile.querySelector(".deckButtonTitle").textContent = action.label;
      tile.setAttribute("aria-label", action.label);
      if (
        !button.appearance.imageId &&
        button.appearance.symbol === (action.defaultSymbol || "\u23ef")
      ) {
        const symbol = tile.querySelector(".deckButtonSymbol");
        if (symbol) symbol.textContent = action.symbol || button.appearance.symbol;
      }
    }
    let status = tile.querySelector(".deckButtonState");
    if (!status) {
      status = node("span", "deckButtonState");
      tile.append(status);
    }
    const label =
      !statusConnected || indicator.label === "Failed" || indicator.label === "Cancelled"
        ? indicator.label
        : typeof feedback === "boolean"
          ? feedback
            ? "Active"
            : ""
          : feedback && typeof feedback === "object"
            ? feedback.label || feedback.text || feedback.status
            : feedback;
    status.textContent =
      running || pending.has(button.id)
        ? "Running…"
        : label
          ? String(label).replaceAll("_", " ")
          : !available(button)
            ? "Unavailable"
            : state?.lastResult && ["Completed", "Failed", "Cancelled"].includes(indicator.label)
              ? state.lastResult.ok
                ? "Done"
                : "Failed"
              : button.kind === "folder"
                ? "Open page"
                : indicator.tone === "rest"
                  ? ""
                  : indicator.label;
    status.hidden =
      !status.textContent ||
      (button.kind === "slider" && /^\d+%?$/.test(status.textContent.trim()));
    tile.dataset.feedback = indicator.tone;
    tile.style.setProperty("--deck-feedback", indicator.color || "var(--accent)");
    tile.dataset.running = String(!!running || pending.has(button.id));
    const pressed =
      typeof feedback === "boolean"
        ? feedback
        : typeof feedback?.active === "boolean"
          ? feedback.active
          : typeof feedback?.muted === "boolean"
            ? feedback.muted
            : feedback?.status === "muted"
              ? true
              : feedback?.status === "unmuted"
                ? false
                : !!state?.toggled;
    tile.dataset.toggled = String(pressed);
    tile.setAttribute("aria-pressed", String(pressed));
    tile.disabled =
      !editing &&
      (!available(button) || (button.kind !== "slider" && (pending.has(button.id) || !!running)));
    const slider = tile.querySelector(".deckVolumeSlider");
    if (slider) {
      slider.disabled = editing || !available(button);
      const level = typeof feedback === "number" ? feedback : (feedback?.value ?? feedback?.level);
      sliderControl(slider)?.sync(level);
    }
    tile.title = editing
      ? "Edit " + button.title
      : !available(button)
        ? typeof label === "string"
          ? button.title + " · " + label
          : "Unavailable: check the action's package or setup"
        : button.holdSteps?.length
          ? button.title +
            " · " +
            indicator.label +
            " · hold for a second action; Shift+Enter runs the hold action"
          : button.title + " · " + (typeof label === "string" ? label : indicator.label);
  }
  async function run(button, trigger = "press", value) {
    if (editing || saving || pending.has(button.id)) return false;
    if (button.kind === "folder") {
      pageId = button.pageId;
      render();
      return;
    }
    pending.add(button.id);
    updateStates();
    try {
      const accepted = await request(
        `/api/control-deck/buttons/${encodeURIComponent(button.id)}/execute`,
        "POST",
        { trigger, ...(value === undefined ? {} : { value }) },
      );
      note("Requested " + button.title + ".");
      if (accepted.navigation) {
        const n = accepted.navigation;
        if (n.panel) await panels.open(n.panel, n);
        else if (n.featureId) openFeaturePage(n.featureId, n.pageId);
        else {
          selectMainTab(n.tab);
          if (n.lightTab) document.querySelector(`[data-light-tab="${n.lightTab}"]`)?.click();
          if (n.musicView)
            document
              .querySelector(`.musicNavigation [data-music-view-target="${n.musicView}"]`)
              ?.click();
        }
      }
      await refresh(true);
      if (button.kind === "slider") {
        const result = await audioUi.wait(accepted.runId, button.id);
        if (result?.ok === false) throw Error(result.code || "slider_change_unconfirmed");
      }
      return true;
    } catch (error) {
      note(explain(error), true);
      return false;
    } finally {
      pending.delete(button.id);
      updateStates();
    }
  }
  function bindTile(tile, button) {
    let consumed = false;
    tile.onclick = (event) => {
      if (consumed && event.detail > 0) {
        consumed = false;
        return;
      }
      consumed = false;
      if (editing) editor.button(button, pageId);
      else void run(button);
    };
    tile.onpointerdown = (event) => {
      if (editing || !button.holdSteps?.length || event.button !== 0 || event.isPrimary === false)
        return;
      consumed = false;
      clearTimeout(holds.get(button.id));
      holds.set(
        button.id,
        setTimeout(() => {
          consumed = true;
          void run(button, "hold");
        }, 550),
      );
    };
    for (const event of ["pointerup", "pointercancel", "pointerleave"])
      tile.addEventListener(event, () => {
        clearTimeout(holds.get(button.id));
        holds.delete(button.id);
      });
    tile.onkeydown = (event) => {
      if (event.key === "Enter" && event.shiftKey && button.holdSteps?.length && !editing) {
        event.preventDefault();
        void run(button, "hold");
      }
    };
    tile.oncontextmenu = (event) => {
      event.preventDefault();
      if (host.dataset.focus === "true") return;
      if (editing || !matchMedia("(pointer: coarse)").matches) editor.button(button, pageId);
    };
  }
  function updateStates() {
    widgets.update(snapshot, editing, statusConnected);
    for (const tile of host.querySelectorAll("[data-deck-button]")) {
      const button = snapshot.config.pages
        .flatMap((p) => p.buttons)
        .find((b) => b.id === tile.dataset.deckButton);
      if (button) paintState(tile, button);
    }
    $("CancelRuns").hidden = !snapshot.running?.length;
    display.schedule();
  }
  function render() {
    widgets.update(snapshot, editing, statusConnected);
    const config = snapshot.config,
      deck = config.mode === "deck";
    if (!deck) fullscreen.leave();
    panel.dataset.dashboardMode = config.mode;
    host.hidden = !deck;
    overview.setAttribute("aria-pressed", String(!deck));
    buttons.setAttribute("aria-pressed", String(deck));
    panel.querySelector("h2").textContent = deck ? "Your controls. One tap away." : original.title;
    panel.querySelector(".dashboardHero p").textContent = deck
      ? "App actions and your own macros, arranged your way."
      : original.help;
    document.getElementById("dashboardEditToggle").hidden = deck;
    const pages = config.pages;
    if (!pages.some((p) => p.id === pageId)) pageId = pages[0].id;
    const page = pages.find((p) => p.id === pageId);
    audioUi.render(config, page, editing, deck);
    colorStyle.textContent = pages
      .flatMap((p) => p.buttons)
      .filter((b) => b.appearance.cycleColors?.length > 1)
      .map((b) => {
        const colors = [...b.appearance.cycleColors, b.appearance.cycleColors[0]];
        return `@keyframes ${colorAnimation(b.id)} {${colors.map((color, i) => `${(i * 100) / (colors.length - 1)}% {--deck-color:${color}}`).join("")}}`;
      })
      .join("\n");
    $("Pages").hidden = pages.length < 2;
    $("NewPage").hidden = $("PageSettings").hidden = setup.hidden = !editing;
    $("Layout").hidden = settingsButton.hidden = !editing;
    syncQuickOptions();
    $("Pages").replaceChildren(
      ...pages.map((p) => {
        const b = node("button", "", p.name);
        b.type = "button";
        b.setAttribute("aria-pressed", String(p.id === pageId));
        b.onclick = () => {
          pageId = p.id;
          render();
        };
        return b;
      }),
    );
    host.dataset.editing = String(editing);
    $("Edit").setAttribute("aria-pressed", String(editing));
    $("Edit").setAttribute("aria-label", editing ? "Done editing buttons" : "Edit buttons");
    $("Edit").classList.add("deckQuietButton");
    $("Edit").textContent = editing ? "Done editing" : "✎ Edit";
    undo.hidden = !undoLayout || undoLayout.revision !== snapshot.revision;
    $("Help").textContent = editing
      ? "Drag to rearrange. Tap to customize. × removes a button; Undo restores a layout change. Buttons do not run while editing."
      : "Tap a button to run it. Hold a button for its optional second action.";
    applyDeckLayout(host, config);
    $("Grid").replaceChildren(
      ...page.buttons.map((button) => {
        const tile = node(button.kind === "slider" ? "div" : "button", "deckButton");
        if (button.kind !== "slider") tile.type = "button";
        else {
          tile.setAttribute("role", "group");
          tile.tabIndex = 0;
        }
        tile.dataset.deckButton = button.id;
        tile.setAttribute("aria-label", button.title);
        appearance(tile, button);
        if (button.kind === "slider") {
          const action = catalog.find((a) => a.id === button.steps[0].actionId),
            spec = action?.control || {};
          appendDeckSlider(
            tile,
            button,
            spec,
            (level) => run(button, "press", level),
            config.layout,
          );
          tile.onclick = (event) => {
            if (editing && !event.target.closest("input")) editor.button(button, pageId);
          };
          tile.onkeydown = (event) => {
            if (editing && event.key === "Enter") editor.button(button, pageId);
          };
        } else bindTile(tile, button);
        tile.addEventListener("pointerdown", (event) => reorder.start(event, button));
        tile.addEventListener(
          "click",
          (event) => {
            if (Date.now() < suppressClickUntil) {
              event.preventDefault();
              event.stopImmediatePropagation();
            }
          },
          true,
        );
        paintState(tile, button);
        if (!editing) return tile;
        const wrapper = node("div", "deckTile"),
          remove = node("button", "deckRemoveButton", "×");
        remove.type = "button";
        remove.setAttribute("aria-label", "Remove " + button.title);
        remove.title = "Remove button (Undo is available)";
        remove.onclick = () => {
          const next = structuredClone(snapshot.config);
          next.pages.find((p) => p.id === pageId).buttons = next.pages
            .find((p) => p.id === pageId)
            .buttons.filter((b) => b.id !== button.id);
          void save(next)
            .then(() => note("Button removed. Undo is available."))
            .catch((e) => note(explain(e), true));
        };
        const grip = node("button", "deckDragHandle", "\u283f");
        grip.type = "button";
        grip.dataset.buttonId = button.id;
        grip.setAttribute("aria-label", "Move " + button.title);
        grip.title = "Drag to move; arrow keys move one position";
        grip.onpointerdown = (event) => {
          event.stopPropagation();
          reorder.start(event, button);
        };
        grip.onkeydown = (event) => {
          if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
          event.preventDefault();
          const at = page.buttons.findIndex((b) => b.id === button.id),
            forward = ["ArrowRight", "ArrowDown"].includes(event.key);
          if (!forward && at === 0) return;
          moveButton(button.id, page.buttons[at + (forward ? 2 : -1)]?.id || "", true);
        };
        wrapper.append(tile, remove, grip);
        return wrapper;
      }),
    );
    const add = node("button", "deckAddButton");
    add.type = "button";
    add.id = "deckAddButton";
    add.setAttribute("aria-label", "Add a button");
    add.append(node("span", "", "+"), node("small", "", "Add button"));
    add.onclick = () => editor.button(null, pageId);
    $("Grid").append(add);
    audioUi.finish(page, editing);
    display.schedule();
    feed.sync();
  }
  const feed = createDeckFeed({
    request,
    visible: isVisible,
    receive({ snapshot: next, catalog: choices }) {
      catalog = choices.actions;
      statusConnected = true;
      const changed = !snapshot || next.revision !== snapshot.revision;
      snapshot = next;
      audioUi.settle();
      if (changed) render();
      else if (!host.querySelector('input[data-dragging="true"]')) updateStates();
      document.dispatchEvent(new CustomEvent("ravelink-deck-state", { detail: next.windowsAudio }));
    },
    offline() {
      statusConnected = false;
      if (snapshot) updateStates();
    },
  });
  function refresh(force = false) {
    return feed.refresh(force);
  }
  $("Edit").onclick = () => {
    editing = !editing;
    render();
    note(editing ? "Edit mode: live actions are disabled." : "Buttons are ready.");
  };
  $("NewPage").onclick = () => editor.page(null);
  $("PageSettings").onclick = () => editor.page(snapshot.config.pages.find((p) => p.id === pageId));
  $("Layout").onclick = () => layout.open();
  $("CancelRuns").onclick = () =>
    void request("/api/control-deck/cancel", "POST", {})
      .then(() => {
        note("Running actions stopped. Actions already completed keep their result.");
        return refresh(true);
      })
      .catch((e) => note(explain(e), true));
  const observer = new IntersectionObserver(() => {
    if (isVisible()) {
      void refresh();
      void audioUi.refresh();
    } else feed.sync();
  });
  observer.observe(panel);
  document.addEventListener("visibilitychange", () => {
    if (isVisible()) void refresh();
    else feed.sync();
  });
  addEventListener("pagehide", () => {
    closed = true;
    clearTimeout(receiptTimer);
    receiptDeadline = Infinity;
    feed.close();
    holds.forEach(clearTimeout);
    reorder.cancel();
    observer.disconnect();
    display.close();
    widgets.close();
    audioUi.close();
  });
  addEventListener("pageshow", () => {
    if (closed) {
      closed = false;
      feed.resume();
      display.resume();
      widgets.resume();
      observer.observe(panel);
      if (isVisible()) void refresh();
    }
  });
  void refresh(true);
  return { active: () => snapshot?.config.mode === "deck", refresh: () => refresh(true) };
}
