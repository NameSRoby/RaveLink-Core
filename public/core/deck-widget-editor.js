import { deckId } from "./control-deck-id.js";
import { widgetNames, createWidgetCard } from "./deck-widget-card.js";
export function createWidgetEditor({ getConfig, save, explain, getSnapshot = () => null }) {
  const dialog = document.createElement("dialog");
  dialog.className = "deckEditor deckWidgetEditor";
  dialog.id = "deckWidgetEditor";
  document.body.append(dialog);
  const el = (tag, text) => {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    return n;
  };
  function field(label, input) {
    const n = el("label");
    n.className = input.type === "checkbox" ? "deckCheck" : "deckField";
    if (input.type === "checkbox") n.append(input, el("span", label));
    else n.append(el("span", label), input);
    return n;
  }
  return {
    open(current) {
      const draft = current
        ? structuredClone(current)
        : {
            id: deckId(),
            type: "now-playing",
            title: "",
            span: 1,
            size: "compact",
            surface: "transparent",
            showTitle: false,
            color: "#a90036",
            artwork: true,
            progress: true,
            requester: true,
            next: true,
            details: false,
            rows: 1,
            clock24: true,
            utc: false,
          };
      dialog.replaceChildren();
      const head = el("div");
      head.className = "deckEditorHeading";
      const close = el("button", "Close");
      close.type = "button";
      close.onclick = () => dialog.close();
      head.append(el("h2", current ? "Customize status widget" : "Add a status widget"), close);
      const form = el("div");
      form.className = "deckWidgetForm";
      const settings = el("div"),
        preview = el("aside"),
        previewBody = el("div");
      settings.className = "deckWidgetSettings";
      preview.className = "deckWidgetPreview";
      preview.append(el("h3", "Preview"), previewBody, el("p", "Changes apply when you save."));
      previewBody.inert = true;
      form.append(settings, preview);
      const groups = {};
      for (const [key, label] of [
        ["identity", "Widget"],
        ["content", "Content"],
        ["layout", "Layout & appearance"],
      ]) {
        const group = el("section");
        group.className = "deckWidgetSection";
        group.append(el("h3", label));
        groups[key] = group;
        settings.append(group);
      }
      const status = el("p");
      status.className = "deckEditorNotice";
      status.setAttribute("role", "status");
      dialog.append(head, form, status);
      const controls = new Map();
      for (const [key, label, kind, choices] of [
        ["type", "Widget", "select", Object.entries(widgetNames)],
        ["title", "Custom title (optional)", "text"],
        ["showTitle", "Show title", "checkbox"],
        ["span", "Width (columns)", "number"],
        [
          "size",
          "Size",
          "select",
          [
            ["compact", "Compact"],
            ["normal", "Normal"],
            ["large", "Large"],
          ],
        ],
        [
          "surface",
          "Background",
          "select",
          [
            ["glass", "Soft acrylic"],
            ["plain", "Plain panel"],
            ["transparent", "Transparent"],
          ],
        ],
        ["color", "Accent / backlight color", "color"],
        ["rows", "List items", "number"],
        ["artwork", "Show cover art", "checkbox"],
        ["progress", "Show song progress", "checkbox"],
        ["requester", "Show who requested it", "checkbox"],
        ["next", "Show next song", "checkbox"],
        ["details", "Show extra details", "checkbox"],
        ["clock24", "24-hour time", "checkbox"],
        ["utc", "Use UTC time", "checkbox"],
      ]) {
        const input = el(kind === "select" ? "select" : "input");
        if (kind === "select")
          for (const [value, text] of choices) input.add(new Option(text, value));
        else input.type = kind;
        if (kind === "checkbox") input.checked = draft[key];
        else input.value = draft[key];
        if (key === "title") input.maxLength = 80;
        if (key === "span") {
          input.min = 1;
          input.max = 6;
          input.step = 1;
        }
        if (key === "rows") {
          input.min = 1;
          input.max = 10;
          input.step = 1;
        }
        input.setAttribute("aria-label", label);
        controls.set(key, input);
        const group = ["type", "title", "showTitle"].includes(key)
          ? "identity"
          : ["span", "size", "surface", "color"].includes(key)
            ? "layout"
            : "content";
        groups[group].append(field(label, input));
      }
      const drawPreview = () => {
        const value = { ...draft };
        for (const [key, input] of controls)
          value[key] =
            input.type === "checkbox"
              ? input.checked
              : input.type === "number"
                ? Number(input.value)
                : input.value;
        const card = createWidgetCard(value, {
          editing: false,
          mark: () => {},
          exportMoments: () => {},
          openTwitch: () => {},
          openObs: () => {},
        });
        delete card.root.dataset.widgetId;
        delete card.root.dataset.widgetType;
        card.update(getSnapshot()?.widgetData || {}, Date.now(), true);
        previewBody.replaceChildren(card.root);
      };
      const contextual = () => {
        const type = controls.get("type").value;
        for (const key of ["artwork", "progress", "requester", "next"])
          controls.get(key).closest("label").hidden =
            type === "now-playing"
              ? false
              : type === "next-request"
                ? !["artwork", "requester"].includes(key)
                : true;
        for (const key of ["clock24", "utc"])
          controls.get(key).closest("label").hidden = !["clock", "stream"].includes(type);
        controls.get("rows").closest("label").hidden = ![
          "clips",
          "markers",
          "audience",
          "followers",
          "rewards",
        ].includes(type);
        controls.get("details").closest("label").hidden = ["viewers", "connections"].includes(type);
        drawPreview();
      };
      controls.get("type").onchange = () => {
        if (!current) {
          const playing = controls.get("type").value === "now-playing";
          controls.get("artwork").checked = playing;
          controls.get("progress").checked = playing;
        }
        contextual();
      };
      controls.get("title").oninput = () => {
        if (controls.get("title").value.trim()) controls.get("showTitle").checked = true;
      };
      form.addEventListener("input", drawPreview);
      form.addEventListener("change", drawPreview);
      contextual();
      const submit = el("button", "Save widget");
      submit.type = "button";
      submit.onclick = async () => {
        submit.disabled = true;
        try {
          for (const [key, input] of controls) {
            if (!input.reportValidity()) throw Error("Check the widget settings.");
            draft[key] =
              input.type === "checkbox"
                ? input.checked
                : input.type === "number"
                  ? Number(input.value)
                  : input.value;
          }
          const config = structuredClone(getConfig()),
            items = config.widgets.items,
            index = items.findIndex((w) => w.id === draft.id);
          if (index >= 0) items[index] = draft;
          else {
            if (items.length >= 24) throw Error("This deck already has 24 widgets.");
            items.push(draft);
          }
          config.widgets.enabled = true;
          await save(config);
          dialog.close();
        } catch (e) {
          status.textContent = explain(e);
        } finally {
          submit.disabled = false;
        }
      };
      const footer = el("div");
      footer.className = "deckWidgetFooter";
      footer.append(submit);
      dialog.append(footer);
      dialog.showModal();
      dialog.scrollTop = 0;
    },
  };
}
