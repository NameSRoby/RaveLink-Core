/** Bundled Lucide paths; selection becomes ordinary local PNG button media. */
const ns = "http://www.w3.org/2000/svg";
let catalog;
async function icons() {
  if (!catalog)
    catalog = fetch("/button-icons/catalog.json")
      .then(async (response) => {
        if (!response.ok) throw Error("The icon library could not be loaded. Try again.");
        return (await response.json()).items;
      })
      .catch((error) => {
        catalog = null;
        throw error;
      });
  return catalog;
}
function graphic(icon, color) {
  const svg = document.createElementNS(ns, "svg");
  for (const [key, value] of Object.entries({
    xmlns: ns,
    viewBox: "0 0 24 24",
    width: "24",
    height: "24",
    fill: "none",
    stroke: color,
    "stroke-width": "1.8",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  }))
    svg.setAttribute(key, value);
  for (const [tag, attrs] of icon.nodes) {
    const part = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attrs)) part.setAttribute(key, value);
    svg.append(part);
  }
  return svg;
}
async function png(icon, color) {
  const svg = graphic(icon, color);
  svg.setAttribute("width", "256");
  svg.setAttribute("height", "256");
  svg.setAttribute("viewBox", "-2 -2 28 28");
  const image = new Image();
  image.src =
    "data:image/svg+xml;charset=utf-8," +
    encodeURIComponent(new XMLSerializer().serializeToString(svg));
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  canvas.getContext("2d").drawImage(image, 0, 0);
  return await new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(Error("Icon could not be rendered."))),
      "image/png",
    ),
  );
}
export async function pickDeckIcon({ color = "#ffffff", apply }) {
  const items = await icons(),
    el = (tag, text) => {
      const n = document.createElement(tag);
      if (text) n.textContent = text;
      return n;
    };
  const dialog = el("dialog");
  dialog.className = "deckEditor deckIconPicker";
  dialog.id = "deckIconPicker";
  dialog.setAttribute("aria-labelledby", "deckIconPickerTitle");
  const heading = el("div"),
    title = el("h2", "Choose an icon"),
    close = el("button", "Close");
  heading.className = "deckEditorHeading";
  title.id = "deckIconPickerTitle";
  close.type = "button";
  close.onclick = () => dialog.close();
  heading.append(title, close);
  const hint = el("p", items.length + " icons, available offline. Search by name or purpose.");
  hint.className = "deckEditorHint";
  const tools = el("div"),
    search = el("input"),
    category = el("select");
  tools.className = "deckIconSearch";
  search.type = "search";
  search.placeholder = "Search icons: microphone, lights, clip...";
  search.setAttribute("aria-label", "Search button icons");
  search.maxLength = 100;
  category.setAttribute("aria-label", "Icon category");
  category.add(new Option("All categories", ""));
  for (const group of new Set(items.map((item) => item.group)))
    category.add(new Option(group, group));
  tools.append(search, category);
  const count = el("p"),
    grid = el("div"),
    footer = el("div"),
    preview = el("span"),
    name = el("span", "Choose an icon"),
    tint = el("input"),
    tintLabel = el("label", "Icon color"),
    use = el("button", "Use icon"),
    status = el("p");
  grid.className = "deckIconGrid";
  grid.setAttribute("aria-label", "Available button icons");
  count.className = "deckIconCount";
  count.setAttribute("role", "status");
  footer.className = "deckIconSelection";
  preview.className = "deckIconSelected";
  tint.type = "color";
  tint.value = color;
  tint.setAttribute("aria-label", "Icon color");
  tintLabel.append(tint);
  use.type = "button";
  use.className = "primary";
  use.disabled = true;
  status.className = "deckEditorNotice";
  status.setAttribute("role", "status");
  footer.append(preview, name, tintLabel, use);
  let selected,
    busy = false;
  function update() {
    preview.replaceChildren(...(selected ? [graphic(selected, tint.value)] : []));
    name.textContent = selected?.label || "Choose an icon";
    use.disabled = !selected;
    for (const button of grid.children) {
      const active = button.dataset.icon === selected?.id;
      button.setAttribute("aria-pressed", String(active));
      button.tabIndex = active ? 0 : -1;
    }
    if (!grid.querySelector('[tabindex="0"]') && grid.firstElementChild)
      grid.firstElementChild.tabIndex = 0;
  }
  function draw() {
    const query = search.value.trim().toLowerCase(),
      words = query.split(/\s+/).filter(Boolean);
    const matches = items.filter(
      (item) =>
        (!category.value || item.group === category.value) &&
        words.every((word) =>
          (item.label + " " + item.tags + " " + item.group).toLowerCase().includes(word),
        ),
    );
    grid.replaceChildren(
      ...matches.map((icon) => {
        const button = el("button"),
          label = el("span", icon.label);
        button.type = "button";
        button.dataset.icon = icon.id;
        button.setAttribute("aria-label", icon.label);
        button.title = icon.label;
        button.append(graphic(icon, "currentColor"), label);
        button.onclick = () => {
          selected = icon;
          update();
        };
        return button;
      }),
    );
    count.textContent = matches.length
      ? matches.length + " icons"
      : "No icons match. Try another search or category.";
    update();
  }
  grid.onkeydown = (event) => {
    const controls = [...grid.children],
      at = controls.indexOf(document.activeElement);
    if (at < 0) return;
    const columns = getComputedStyle(grid).gridTemplateColumns.split(" ").length,
      moves = {
        ArrowLeft: -1,
        ArrowRight: 1,
        ArrowUp: -columns,
        ArrowDown: columns,
        Home: -at,
        End: controls.length - 1 - at,
      };
    if (!(event.key in moves)) return;
    event.preventDefault();
    const next = Math.max(0, Math.min(controls.length - 1, at + moves[event.key]));
    controls[at].tabIndex = -1;
    controls[next].tabIndex = 0;
    controls[next].focus();
  };
  search.oninput = category.onchange = draw;
  tint.oninput = update;
  use.onclick = async () => {
    if (busy || !selected) return;
    busy = true;
    dialog.inert = true;
    try {
      await apply(await png(selected, tint.value), selected.label);
      dialog.close();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      busy = false;
      dialog.inert = false;
    }
  };
  dialog.addEventListener("cancel", (event) => {
    if (busy) event.preventDefault();
  });
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  dialog.append(heading, hint, tools, count, grid, footer, status);
  document.body.append(dialog);
  draw();
  dialog.showModal();
  search.focus();
}
