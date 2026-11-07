import { deckId as id } from "./control-deck-id.js";
/** Local button drafts. Preview/edit operations never call the execution API. */
import { buildActionSteps } from "./control-deck-steps.js";
import { profileLightingFor, paintProfileLighting } from "./control-deck-profile-light.js";
import { createToggleStates } from "./control-deck-toggle-editor.js";
import { keyControl } from "./control-deck-keys.js";
const clone = (value) => structuredClone(value);
const node = (tag, className, text) => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
};
const field = (label, control) => {
  const el = node("label", "deckField");
  el.append(node("span", "", label), control);
  return el;
};
function input(type, value, maxLength) {
  const el = node("input");
  el.type = type;
  el.value = value;
  if (maxLength) el.maxLength = maxLength;
  return el;
}
function select(rows, value) {
  const el = node("select");
  for (const [id, title] of rows) el.add(new Option(title, id));
  el.value = value;
  return el;
}
export function createDeckEditor({
  request,
  save,
  getConfig,
  getCatalog,
  onPage,
  note,
  onObsSetup,
}) {
  let busy = false;
  const dialog = node("dialog", "deckEditor");
  dialog.id = "deckEditor";
  document.body.append(dialog);
  function close() {
    if (!busy) dialog.close();
  }
  function base(title, help) {
    dialog.replaceChildren();
    const heading = node("div", "deckEditorHeading"),
      h = node("h2", "", title),
      cancel = node("button", "", "Close");
    cancel.type = "button";
    cancel.onclick = close;
    heading.append(h, cancel);
    const status = node("p", "deckEditorNotice");
    status.id = "deckEditorNotice";
    status.setAttribute("role", "status");
    dialog.append(heading, node("p", "deckEditorHint", help), status);
    return status;
  }
  function error(status, message) {
    status.textContent = String(message).replaceAll("_", " ");
    status.dataset.error = "true";
  }
  async function commit(fn, status) {
    if (busy) return;
    busy = true;
    dialog.querySelectorAll("button,input,select,textarea").forEach((el) => (el.disabled = true));
    try {
      await fn();
      dialog.close();
      note("Button deck saved.");
    } catch (e) {
      error(status, e.message);
    } finally {
      busy = false;
      dialog
        .querySelectorAll("button,input,select,textarea")
        .forEach((el) => (el.disabled = false));
    }
  }
  function show() {
    if (!dialog.open) dialog.showModal();
  }
  dialog.addEventListener("cancel", (event) => {
    if (busy) event.preventDefault();
  });
  function page(current) {
    const config = clone(getConfig()),
      status = base(
        current ? "Page settings" : "Add a page",
        "Organize buttons into pages. A folder button can open any page.",
      );
    const name = input("text", current?.name || "New page", 60);
    name.id = "deckPageName";
    dialog.append(field("Page name", name));
    const mixerEnabled = input("checkbox", "");
    mixerEnabled.checked = current?.mixer?.enabled === true;
    dialog.append(field("Include live Windows audio mixer", mixerEnabled));
    const actions = node("div", "deckEditorActions"),
      submit = node("button", "primary", "Save page");
    submit.type = "button";
    submit.onclick = () => {
      if (!name.value.trim()) return error(status, "Enter a page name.");
      void commit(async () => {
        const pageId = current?.id || id();
        if (current) {
          const page = config.pages.find((p) => p.id === pageId);
          page.name = name.value.trim();
          page.mixer = {
            enabled: mixerEnabled.checked,
            hiddenTargets: page.mixer?.hiddenTargets || [],
          };
        } else
          config.pages.push({
            id: pageId,
            name: name.value.trim(),
            buttons: [],
            mixer: { enabled: mixerEnabled.checked, hiddenTargets: [] },
          });
        await save(config);
        onPage(pageId);
      }, status);
    };
    actions.append(submit);
    if (current) {
      const remove = node("button", "", "Delete page");
      remove.type = "button";
      remove.disabled = config.pages.length === 1;
      remove.title = "Remove this page and its buttons. Folder links to it must be removed first.";
      remove.onclick = () => {
        if (
          config.pages.some(
            (p) =>
              p.id !== current.id &&
              p.buttons.some((b) => b.kind === "folder" && b.pageId === current.id),
          )
        )
          return error(
            status,
            "A folder still opens this page. Change or delete that folder first.",
          );
        if (remove.dataset.confirm !== "true") {
          remove.dataset.confirm = "true";
          remove.textContent = "Confirm delete page & buttons";
          return;
        }
        void commit(async () => {
          config.pages = config.pages.filter((p) => p.id !== current.id);
          await save(config);
        }, status);
      };
      actions.append(remove);
    }
    dialog.append(actions);
    show();
    name.focus();
  }
  function button(current, pageId) {
    const sendKey = (shortcut) => request("/api/control-deck/windows/hotkey", "POST", { shortcut });
    const config = clone(getConfig()),
      catalog = getCatalog(),
      parent = config.pages.find((p) => p.id === pageId);
    const draft = current
      ? clone(current)
      : {
          id: id(),
          title: "New button",
          kind: "macro",
          steps: [],
          alternateSteps: [],
          holdSteps: [],
          appearance: {
            symbol: "◆",
            textMode: "auto",
            imageId: "",
            color: "#a90036",
            cycleColors: [],
            textColor: "#ffffff",
            cycleMs: 6000,
          },
        };
    const status = base(
      current ? "Edit button" : "Add a button",
      "Choose an app action or a function supplied by a mod. Saving a button does not run it.",
    );
    const quickActions = node("div", "deckEditorQuickActions");
    if (!current && onObsSetup) {
      const obsButton = node("button", "deckQuickButton", "Create an OBS button");
      obsButton.type = "button";
      obsButton.onclick = () => {
        close();
        void onObsSetup();
      };
      quickActions.append(obsButton);
    }
    let imageId = draft.appearance?.imageId || "";
    const layout = node("div", "deckEditorLayout"),
      library = node("section", "deckActionLibrary"),
      form = node("section", "deckButtonForm");
    library.append(node("h3", "", "Action library"));
    const search = input("search", "");
    search.id = "deckActionSearch";
    search.placeholder = "Find music, lights, mods…";
    search.setAttribute("aria-label", "Find an action");
    const list = node("div", "deckActionList");
    library.append(search, list);
    const title = input("text", draft.title, 80);
    title.id = "deckButtonName";
    const behavior = select(
      [
        ["action", "Run actions"],
        ["slider", "Volume / value slider"],
        ["toggle", "Toggle · first / second press"],
        ["folder", "Open a page / folder"],
      ],
      draft.kind === "folder"
        ? "folder"
        : draft.kind === "slider"
          ? "slider"
          : draft.alternateSteps?.length
            ? "toggle"
            : "action",
    );
    behavior.id = "deckButtonBehavior";
    const targetPage = select(
      config.pages.map((p) => [p.id, p.name]),
      draft.pageId || config.pages[0].id,
    );
    targetPage.id = "deckFolderPage";
    const pageField = field("Page to open", targetPage);
    form.append(field("Button name", title), field("Button behavior", behavior), pageField);
    const trigger = keyControl({
      value: draft.activationKey || "",
      label: "Keyboard trigger (RaveLink focused)",
    });
    form.append(trigger.field);
    const sliderDirection = select(
        [
          ["inherit", "Use deck setting"],
          ["vertical", "Vertical"],
          ["horizontal", "Horizontal"],
        ],
        draft.appearance.sliderOrientation || "inherit",
      ),
      sliderStyle = select(
        [
          ["inherit", "Use deck setting"],
          ["mixer", "Mixer strip"],
          ["button", "Acrylic button"],
        ],
        draft.appearance.sliderStyle || "inherit",
      );
    const sliderSnap = select(
        [
          ["inherit", "Use deck setting"],
          ["off", "Smooth"],
          ["on", "Snap to increments"],
        ],
        draft.appearance.sliderSnap || "inherit",
      ),
      sliderIncrement = input("number", draft.appearance.sliderIncrement ?? 5);
    sliderIncrement.min = 1;
    sliderIncrement.max = 100;
    sliderIncrement.step = 1;
    const incrementField = field("Snap increment (%)", sliderIncrement);
    sliderSnap.onchange = () => (incrementField.hidden = sliderSnap.value !== "on");
    sliderSnap.onchange();
    const sliderOptions = node("div", "deckAppearanceFields");
    sliderOptions.append(
      field("Slider orientation", sliderDirection),
      field("Slider appearance", sliderStyle),
      field("Slider movement", sliderSnap),
      incrementField,
    );
    form.append(sliderOptions);
    const press = node("section", "deckSequence"),
      alternate = node("section", "deckSequence"),
      hold = node("details", "deckHoldEditor");
    const pressEditor = buildActionSteps(
      press,
      "Press action",
      draft.steps || [],
      catalog,
      sendKey,
    );
    const alternateEditor = buildActionSteps(
      alternate,
      "Second press action",
      draft.alternateSteps || [],
      catalog,
      sendKey,
    );
    hold.append(node("summary", "", "Optional hold action"));
    const holdEditor = buildActionSteps(
      hold,
      "Hold for a second action",
      draft.holdSteps || [],
      catalog,
      sendKey,
    );
    hold.open = !!draft.holdSteps?.length;
    form.append(press, alternate, hold);
    const toggleStates = createToggleStates({
      node,
      field,
      input,
      value: draft.toggleStates,
      symbol: draft.appearance.symbol || "\u25c6",
    });
    form.append(toggleStates.element);
    const actionTarget = select(
      [
        ["first", "First press"],
        ["second", "Second press"],
      ],
      "first",
    );
    actionTarget.id = "deckToggleActionTarget";
    const actionTargetField = field("Add library action to", actionTarget);
    library.insertBefore(actionTargetField, list);
    const toggleShortcut = node("button", "deckQuickButton", "Create a toggle");
    toggleShortcut.type = "button";
    toggleShortcut.onclick = () => {
      behavior.value = "toggle";
      visibility();
      actionTarget.focus();
    };
    quickActions.append(toggleShortcut);
    const keyboard = node("button", "deckKeyboardPreset", "⌨ Keyboard key");
    keyboard.type = "button";
    keyboard.onclick = () => {
      behavior.value = "action";
      behavior.dispatchEvent(new Event("change"));
      pressEditor.replace([{ actionId: "native.hotkey", params: { shortcut: "F13" }, delayMs: 0 }]);
      if (!current && title.value === "New button") title.value = "Keyboard key";
      press.querySelector('[data-deck-parameter="shortcut"]')?.focus();
    };
    if (catalog.some((a) => a.id === "native.hotkey")) quickActions.append(keyboard);
    if (quickActions.childElementCount) library.prepend(quickActions);
    const appearance = node("details", "deckAppearanceEditor");
    appearance.open = true;
    appearance.append(node("summary", "", "Button appearance"));
    const fields = node("div", "deckAppearanceFields"),
      preview = node("div", "deckAppearancePreview deckButton"),
      previewImage = node("img", "deckButtonImage"),
      previewSymbol = node("span", "deckButtonSymbol"),
      previewTitle = node("strong", "deckButtonTitle");
    preview.setAttribute("aria-label", "Button appearance preview");
    previewImage.alt = "";
    preview.append(
      node("span", "deckLedSource"),
      node("span", "deckAcrylicFace"),
      previewImage,
      previewSymbol,
      previewTitle,
    );
    const symbol = input("text", draft.appearance.symbol || "◆", 24);
    symbol.id = "deckButtonSymbol";
    const display = select(
      [
        ["auto", "Auto (fit content)"],
        ["image-text", "Icon + text"],
        ["image", "Icon / image only"],
        ["text", "Text only"],
        ["alternate", "Alternate icon / text"],
      ],
      draft.appearance.textMode || "auto",
    );
    display.id = "deckButtonDisplay";
    const displayField = field("Display", display),
      displayHelp = node(
        "small",
        "",
        "Auto fits the icon and text to the button. Alternate switches between them periodically. The deck display setting can override this choice.",
      );
    displayHelp.id = "deckButtonDisplayHelp";
    display.setAttribute("aria-describedby", displayHelp.id);
    displayField.append(displayHelp);
    const color = input("color", draft.appearance.color || "#a90036"),
      textColor = input("color", draft.appearance.textColor || "#ffffff");
    color.id = "deckButtonColor";
    textColor.id = "deckButtonTextColor";
    const backlight = input("range", draft.appearance.backlight ?? 65),
      backlightValue = node("output", "", backlight.value + "%");
    backlight.id = "deckButtonBacklight";
    backlight.min = 0;
    backlight.max = 100;
    backlight.step = 1;
    const backlightField = field("Backlight brightness (0 = off)", backlight);
    backlightField.append(backlightValue);
    const profileColors = input("checkbox", "");
    profileColors.id = "deckButtonProfileColors";
    profileColors.checked = draft.appearance.profileBacklight !== "custom";
    const profileColorsField = node("label", "deckCheck");
    profileColorsField.append(
      profileColors,
      node("span", "", "Use fixture / profile colors for the backlight"),
    );
    const file = input("file", "");
    file.id = "deckButtonImage";
    file.accept = "image/png,image/jpeg,image/gif";
    const removeImage = node("button", "", "Use symbol instead");
    removeImage.type = "button";
    removeImage.onclick = () => {
      imageId = "";
      redrawPreview();
    };
    const chooseIcon = node("button", "", "Choose from icon library");
    chooseIcon.type = "button";
    chooseIcon.onclick = async () => {
      chooseIcon.disabled = true;
      try {
        const { pickDeckIcon } = await import("./control-deck-icon-picker.js");
        await pickDeckIcon({
          color: textColor.value,
          apply: async (image, label) => {
            const media = await request("/api/control-deck/media", "POST", image, true);
            imageId = media.id;
            redrawPreview();
            status.textContent = label + " icon ready. Save the button to use it.";
          },
        });
      } catch (e) {
        error(status, e.message);
      } finally {
        chooseIcon.disabled = false;
      }
    };
    const animation = select(
      [
        ["static", "Static color"],
        ["cycle", "Cycle colors"],
      ],
      draft.appearance.cycleColors?.length > 1 ? "cycle" : "static",
    );
    animation.id = "deckButtonAnimation";
    const cycle = node("div", "deckCycleFields"),
      colors = (
        draft.appearance.cycleColors?.length > 1
          ? draft.appearance.cycleColors
          : [color.value, "#71364b", "#263a60"]
      ).map((value) => input("color", value));
    function drawColors() {
      cycle.replaceChildren(
        ...colors.map((el, i) => {
          const row = node("span", "deckCycleStop"),
            remove = node("button", "deckSmallButton", "×");
          el.setAttribute("aria-label", "Cycle color " + (i + 1));
          remove.type = "button";
          remove.setAttribute("aria-label", "Remove cycle color " + (i + 1));
          remove.disabled = colors.length <= 2;
          remove.onclick = () => {
            colors.splice(i, 1);
            drawColors();
          };
          row.append(el, remove);
          return row;
        }),
      );
      const add = node("button", "", "+ Color");
      add.type = "button";
      add.disabled = colors.length >= 8;
      add.onclick = () => {
        colors.push(input("color", color.value));
        drawColors();
      };
      cycle.append(add);
    }
    drawColors();
    const duration = input("number", (draft.appearance.cycleMs || 6000) / 1000);
    duration.min = 1;
    duration.max = 30;
    duration.step = 1;
    duration.id = "deckButtonCycleSeconds";
    fields.append(
      chooseIcon,
      field("Symbol / emoji", symbol),
      displayField,
      field("Backlight color", color),
      backlightField,
      profileColorsField,
      field("Text color", textColor),
      field("Color behavior", animation),
      field("Cycle duration (seconds)", duration),
      cycle,
      field("PNG, JPEG or animated GIF · up to 2 MB", file),
      removeImage,
    );
    appearance.append(fields, preview);
    form.append(appearance);
    const order = select(
      parent.buttons
        .map((b, i) => [String(i), `${i + 1} · ${b.title}`])
        .concat(current ? [] : [[String(parent.buttons.length), "At the end"]]),
      String(
        current ? parent.buttons.findIndex((b) => b.id === current.id) : parent.buttons.length,
      ),
    );
    order.id = "deckButtonOrder";
    form.append(field("Position on this page", order));
    layout.append(library, form);
    dialog.append(layout);
    function redrawPreview() {
      const lights = profileLightingFor(pressEditor.read(), catalog);
      profileColorsField.hidden = !lights;
      paintProfileLighting(preview, lights, profileColors.checked);
      preview.style.setProperty("--deck-color", color.value);
      preview.style.setProperty("--deck-backlight", Number(backlight.value) / 100);
      preview.style.setProperty(
        "--deck-master-backlight",
        (getConfig().layout?.backlight ?? 100) / 100,
      );
      backlightValue.textContent = backlight.value + "%";
      preview.style.color = textColor.value;
      preview.dataset.displayMode = display.value === "auto" ? "image-text" : display.value;
      cycle.hidden = animation.value !== "cycle";
      duration.disabled = animation.value !== "cycle";
      previewImage.hidden = display.value === "text" || !imageId;
      if (imageId) {
        const imagePath = "/api/control-deck/media/" + encodeURIComponent(imageId);
        if (previewImage.getAttribute("src") !== imagePath) previewImage.src = imagePath;
      }
      previewSymbol.hidden = display.value === "text" || !!imageId;
      previewSymbol.textContent = symbol.value;
      previewTitle.hidden = display.value === "image";
      previewTitle.textContent = title.value || "New button";
    }
    function visibility() {
      const folder = behavior.value === "folder";
      sliderOptions.hidden = behavior.value !== "slider";
      pageField.hidden = !folder;
      press.hidden = folder;
      alternate.hidden = behavior.value !== "toggle";
      press.querySelector("h3").textContent =
        behavior.value === "toggle" ? "First press actions" : "Press action";
      toggleStates.element.hidden = actionTargetField.hidden = behavior.value !== "toggle";
      hold.hidden = folder || behavior.value === "slider";
    }
    function choose(action) {
      const targetEditor =
        behavior.value === "toggle" && actionTarget.value === "second"
          ? alternateEditor
          : pressEditor;
      targetEditor.replace([
        { actionId: action.id, params: clone(action.defaults || {}), delayMs: 0 },
      ]);
      if (!current && (title.value === "New button" || !title.value.trim()))
        title.value = action.defaultTitle || action.label;
      if (!current) symbol.value = action.defaultSymbol || action.symbol || "◆";
      if (action.control?.type === "slider") behavior.value = "slider";
      else if (["folder", "slider"].includes(behavior.value)) behavior.value = "action";
      visibility();
      redrawPreview();
    }
    profileColors.onchange = redrawPreview;
    color.addEventListener("input", () => {
      profileColors.checked = false;
      redrawPreview();
    });
    animation.addEventListener("change", () => {
      profileColors.checked = false;
      redrawPreview();
    });
    function drawLibrary() {
      const query = search.value.trim().toLowerCase();
      list.replaceChildren(
        ...catalog
          .filter((a) => `${a.label} ${a.description} ${a.group}`.toLowerCase().includes(query))
          .map((action) => {
            const button = node("button", "deckActionChoice");
            button.type = "button";
            button.dataset.deckAction = action.id;
            button.append(
              node("span", "deckActionSymbol", action.symbol || "◆"),
              node("strong", "", action.label),
              node(
                "small",
                "",
                `${action.group}${action.available === false ? " · Unavailable" : ""}`,
              ),
            );
            button.title = action.description || action.label;
            button.onclick = () => choose(action);
            return button;
          }),
      );
      if (!list.children.length)
        list.append(
          node("p", "", "No matching actions. Enabled mods can add functions to this library."),
        );
    }
    file.onchange = async () => {
      const image = file.files[0];
      if (!image) return;
      if (!["image/png", "image/jpeg", "image/gif"].includes(image.type) || image.size > 2097152)
        return error(status, "Choose a PNG, JPEG or GIF of at most 2 MB.");
      try {
        file.disabled = true;
        const media = await request("/api/control-deck/media", "POST", image, true);
        imageId = media.id;
        redrawPreview();
        status.textContent = "Image ready. Save the button to use it.";
      } catch (e) {
        error(status, e.message);
      } finally {
        file.disabled = false;
      }
    };
    for (const control of [title, symbol, display, color, textColor, animation, backlight])
      control.oninput = redrawPreview;
    search.oninput = drawLibrary;
    behavior.onchange = visibility;
    const actions = node("div", "deckEditorActions"),
      submit = node("button", "primary", "Save button");
    submit.type = "button";
    submit.id = "deckSaveButton";
    submit.onclick = () => {
      if (!title.value.trim()) return error(status, "Enter a button name.");
      let steps, alternateSteps, holdSteps;
      try {
        steps = behavior.value === "folder" ? [] : pressEditor.read();
        alternateSteps = behavior.value === "toggle" ? alternateEditor.read() : [];
        holdSteps = behavior.value === "folder" ? [] : holdEditor.read();
      } catch (e) {
        return error(status, e.message);
      }
      if (behavior.value !== "folder" && !steps.length)
        return error(status, "Choose an action from the library.");
      if (behavior.value === "toggle" && !alternateSteps.length)
        return error(status, "Add the second press action for this switch.");
      if (
        behavior.value === "slider" &&
        (steps.length !== 1 || !catalog.find((a) => a.id === steps[0].actionId)?.control)
      )
        return error(status, "Choose one volume or slider action from the library.");
      const value = {
        ...draft,
        title: title.value.trim(),
        kind:
          behavior.value === "folder" ? "folder" : behavior.value === "slider" ? "slider" : "macro",
        ...(behavior.value === "folder" ? { pageId: targetPage.value } : {}),
        steps,
        alternateSteps,
        activationKey: trigger.input.value,
        ...(behavior.value === "toggle" ? { toggleStates: toggleStates.read() } : {}),
        holdSteps: behavior.value === "slider" ? [] : holdSteps,
        appearance: {
          symbol: symbol.value,
          sliderOrientation: sliderDirection.value,
          sliderStyle: sliderStyle.value,
          sliderSnap: sliderSnap.value,
          sliderIncrement: Number(sliderIncrement.value),
          textMode: display.value,
          imageId,
          color: color.value,
          backlight: Number(backlight.value),
          profileBacklight: profileColors.checked ? "auto" : "custom",
          textColor: textColor.value,
          cycleColors: animation.value === "cycle" ? colors.map((c) => c.value) : [],
          cycleMs: Math.round(Number(duration.value) * 1000),
        },
      };
      if (behavior.value !== "toggle") delete value.toggleStates;
      if (value.kind !== "folder") delete value.pageId;
      void commit(async () => {
        parent.buttons = parent.buttons.filter((b) => b.id !== draft.id);
        parent.buttons.splice(Number(order.value), 0, value);
        await save(config);
      }, status);
    };
    actions.append(submit);
    if (current) {
      const remove = node("button", "", "Delete button");
      remove.type = "button";
      remove.id = "deckDeleteButton";
      remove.onclick = () => {
        if (remove.dataset.confirm !== "true") {
          remove.dataset.confirm = "true";
          remove.textContent = "Confirm delete";
          return;
        }
        void commit(async () => {
          parent.buttons = parent.buttons.filter((b) => b.id !== draft.id);
          await save(config);
        }, status);
      };
      actions.append(remove);
    }
    dialog.append(actions);
    drawLibrary();
    visibility();
    redrawPreview();
    show();
    title.focus();
    title.select();
  }
  return { button, page };
}
