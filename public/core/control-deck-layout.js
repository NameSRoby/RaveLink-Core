import { keyControl } from "./control-deck-keys.js";
import { createDeckScreen } from "./control-deck-screen.js";
import { createScreenEditor } from "./control-deck-screen-editor.js";
const screens = new WeakMap();
/** Shared deck layout, with independent row counts for each screen size. */
const defaults = {
  backlight: 100,
  phoneColumns: 2,
  tabletColumns: 4,
  gap: 14,
  radius: 28,
  labelScale: 100,
  showStatus: true,
  shape: "square",
  display: "auto",
  fullscreenMode: "scroll",
  fullscreenSwipe: false,
  fullscreenKeyboard: false,
  previousKey: "ArrowLeft",
  nextKey: "ArrowRight",
  keyboardButtons: false,
  sliderOrientation: "vertical",
  sliderStyle: "mixer",
  sliderPlacement: "dock",
  sliderDock: "end",
  sliderSnap: false,
  sliderIncrement: 5,
};
export function applyDeckLayout(host, config) {
  if (!screens.has(host)) screens.set(host, createDeckScreen(host));
  screens.get(host).update(config.layout?.screen);
  const layout = { ...defaults, ...config.layout };
  host.dataset.sliderOrientation = layout.sliderOrientation;
  host.dataset.sliderDock = layout.sliderDock;
  for (const [name, value] of Object.entries({
    columns: config.columns,
    "phone-columns": layout.phoneColumns,
    "tablet-columns": layout.tabletColumns,
    gap: layout.gap + "px",
    radius: layout.radius + "px",
    "label-scale": layout.labelScale / 100,
    "master-backlight": layout.backlight / 100,
    aspect: { square: "1", wide: "4 / 3", tall: "3 / 4" }[layout.shape],
  }))
    host.style.setProperty("--deck-" + name, value);
  host.dataset.showStatus = String(layout.showStatus);
  host.dataset.display = layout.display;
}
export function createDeckLayout({ host, getConfig, save, explain, request }) {
  const dialog = document.createElement("dialog");
  dialog.className = "deckEditor deckLayoutEditor";
  dialog.id = "deckLayoutEditor";
  dialog.setAttribute("aria-labelledby", "deckLayoutTitle");
  dialog.innerHTML =
    '<form><div class="deckEditorHeading"><h2 id="deckLayoutTitle">Deck layout</h2><button type="button" id="deckLayoutClose" aria-label="Close layout settings">×</button></div><p class="deckEditorHint">Choose how many buttons fit each row. Settings follow your deck on all devices. Dense rows scroll sideways when needed to keep controls usable.</p><div class="deckLayoutFields"></div><p class="deckEditorNotice" role="status" aria-live="polite"></p><div class="deckEditorActions"><button type="button" id="deckLayoutReset">Reset layout</button><button type="submit" id="deckLayoutSave">Save layout</button></div></form>';
  document.body.append(dialog);
  const fields = dialog.querySelector(".deckLayoutFields"),
    controls = {};
  for (const [key, title, min, max] of [
    ["columns", "Desktop buttons per row", 1, 12],
    ["tabletColumns", "Tablet buttons per row", 1, 12],
    ["phoneColumns", "Phone buttons per row", 1, 12],
    ["gap", "Spacing (px)", 0, 32],
    ["radius", "Corner radius (px)", 0, 32],
    ["labelScale", "Label size (%)", 70, 150],
    ["backlight", "Master backlight (%)", 0, 100],
    ["sliderIncrement", "Slider snap increment (%)", 1, 100],
  ]) {
    const label = document.createElement("label"),
      input = document.createElement("input");
    label.className = "deckField";
    label.textContent = title;
    input.type = "number";
    input.min = min;
    input.max = max;
    input.step = 1;
    input.id = "deckLayout" + key[0].toUpperCase() + key.slice(1);
    label.append(input);
    fields.append(label);
    controls[key] = input;
  }
  const shape = document.createElement("label");
  shape.className = "deckField";
  shape.textContent = "Button shape";
  const select = document.createElement("select");
  select.id = "deckLayoutShape";
  for (const [value, text] of [
    ["square", "Square"],
    ["wide", "Wide"],
    ["tall", "Tall"],
  ])
    select.add(new Option(text, value));
  shape.append(select);
  fields.append(shape);
  controls.shape = select;
  const display = document.createElement("label");
  display.className = "deckField";
  display.textContent = "Button display";
  const displaySelect = document.createElement("select"),
    displayHelp = document.createElement("small");
  displaySelect.id = "deckLayoutDisplay";
  for (const [value, text] of [
    ["auto", "Auto (fit content)"],
    ["per-button", "Use each button's setting"],
    ["image-text", "Icon + text"],
    ["image", "Icon / image only"],
    ["text", "Text only"],
    ["alternate", "Alternate icon / text"],
  ])
    displaySelect.add(new Option(text, value));
  displayHelp.id = "deckLayoutDisplayHelp";
  displayHelp.textContent =
    "Auto fits the content to each button. Alternate switches between the icon and text periodically. Choose each button's setting to use its individual display choice.";
  displaySelect.setAttribute("aria-describedby", displayHelp.id);
  display.append(displaySelect, displayHelp);
  fields.append(display);
  controls.display = displaySelect;
  const status = document.createElement("label");
  status.className = "deckField deckLayoutCheck";
  const checkbox = document.createElement("input");
  checkbox.id = "deckLayoutShowStatus";
  checkbox.type = "checkbox";
  status.append(checkbox, document.createTextNode("Show button status labels"));
  fields.append(status);
  controls.showStatus = checkbox;
  for (const [key, title, rows] of [
    [
      "sliderOrientation",
      "Slider orientation",
      [
        ["vertical", "Vertical"],
        ["horizontal", "Horizontal"],
      ],
    ],
    [
      "sliderStyle",
      "Slider appearance",
      [
        ["mixer", "Mixer strips"],
        ["button", "Inside acrylic buttons"],
      ],
    ],
    [
      "sliderPlacement",
      "Slider placement",
      [
        ["dock", "Dock beside the buttons"],
        ["page", "Keep sliders on the Audio mixer page"],
      ],
    ],
    [
      "sliderDock",
      "Dock side",
      [
        ["start", "Left (vertical) / top (horizontal)"],
        ["end", "Right (vertical) / bottom (horizontal)"],
      ],
    ],
  ]) {
    const label = document.createElement("label"),
      select = document.createElement("select");
    label.className = "deckField";
    label.append(document.createTextNode(title));
    select.id = "deckLayout" + key[0].toUpperCase() + key.slice(1);
    for (const [value, text] of rows) select.add(new Option(text, value));
    label.append(select);
    fields.append(label);
    controls[key] = select;
  }
  const navigation = document.createElement("label");
  navigation.className = "deckField";
  navigation.append(document.createTextNode("Fullscreen navigation"));
  const navigationSelect = document.createElement("select");
  navigationSelect.id = "deckLayoutFullscreenMode";
  navigationSelect.add(new Option("Scroll (current layout)", "scroll"));
  navigationSelect.add(new Option("Pages · swipe or keyboard", "pages"));
  navigation.append(navigationSelect);
  fields.append(navigation);
  controls.fullscreenMode = navigationSelect;
  for (const [key, label] of [
    ["fullscreenSwipe", "Swipe between fullscreen pages"],
    ["fullscreenKeyboard", "Keyboard page navigation"],
    ["keyboardButtons", "Enable button keyboard triggers (RaveLink focused)"],
    ["sliderSnap", "Snap sliders to the chosen increment"],
  ]) {
    const field = document.createElement("label"),
      input = document.createElement("input");
    field.className = "deckField deckLayoutCheck";
    input.type = "checkbox";
    input.id = "deckLayout" + key[0].toUpperCase() + key.slice(1);
    field.append(input, document.createTextNode(label));
    fields.append(field);
    controls[key] = input;
  }
  const snapLabel = controls.sliderSnap.closest("label"),
    incrementLabel = controls.sliderIncrement.closest("label");
  controls.sliderDock.closest("label").after(snapLabel, incrementLabel);
  controls.sliderSnap.onchange = () => (incrementLabel.hidden = !controls.sliderSnap.checked);
  navigationSelect.addEventListener("change", () => {
    if (navigationSelect.value === "scroll") {
      controls.fullscreenSwipe.checked = false;
      controls.fullscreenKeyboard.checked = false;
    }
  });
  for (const key of ["fullscreenSwipe", "fullscreenKeyboard"])
    controls[key].addEventListener("change", () => {
      if (controls[key].checked) navigationSelect.value = "pages";
    });
  for (const [key, label] of [
    ["previousKey", "Previous screen key"],
    ["nextKey", "Next screen key"],
  ]) {
    const control = keyControl({ label });
    fields.append(control.field);
    controls[key] = control.input;
  }
  const notice = dialog.querySelector(".deckEditorNotice"),
    submit = dialog.querySelector('[type="submit"]');
  let saving = false;
  const screen = createScreenEditor({ request, onChange: () => applyDeckLayout(host, read()) });
  fields.append(screen.element);
  function read() {
    const layout = {};
    for (const [key, input] of Object.entries(controls))
      if (key !== "columns")
        layout[key] =
          input.type === "checkbox"
            ? input.checked
            : input.type === "number"
              ? Number(input.value)
              : input.value;
    layout.screen = screen.read();
    return { ...getConfig(), columns: Number(controls.columns.value), layout };
  }
  function fill(config) {
    screen.fill(config.layout?.screen);
    const values = { ...defaults, ...config.layout, columns: config.columns };
    for (const [key, input] of Object.entries(controls))
      if (input.type === "checkbox") input.checked = values[key];
      else input.value = values[key];
    controls.sliderSnap.onchange();
  }
  fields.addEventListener("input", () => {
    if (dialog.querySelector("form").checkValidity()) applyDeckLayout(host, read());
  });
  function close() {
    if (!saving) {
      applyDeckLayout(host, getConfig());
      dialog.close();
    }
  }
  dialog.querySelector("#deckLayoutClose").onclick = close;
  dialog.addEventListener("cancel", (event) => {
    if (saving) event.preventDefault();
  });
  dialog.addEventListener("close", () => applyDeckLayout(host, getConfig()));
  dialog.querySelector("#deckLayoutReset").onclick = () => {
    fill({ columns: 5, layout: defaults });
    applyDeckLayout(host, read());
  };
  dialog.querySelector("form").onsubmit = async (event) => {
    event.preventDefault();
    if (saving) return;
    saving = true;
    submit.disabled = true;
    notice.textContent = "Saving…";
    try {
      await save(read());
      saving = false;
      dialog.close();
    } catch (error) {
      notice.textContent = explain(error);
      notice.dataset.error = "true";
    } finally {
      saving = false;
      submit.disabled = false;
    }
  };
  return {
    open() {
      fill(getConfig());
      notice.textContent = "";
      delete notice.dataset.error;
      dialog.showModal();
    },
  };
}
