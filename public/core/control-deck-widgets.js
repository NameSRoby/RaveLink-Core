import { createWidgetCard, widgetNames } from "./deck-widget-card.js";
import { createWidgetEditor } from "./deck-widget-editor.js";
import { deckId } from "./control-deck-id.js";
export function createDeckWidgets({
  host,
  request,
  save,
  getConfig,
  visible,
  refresh,
  explain,
  openTwitch,
  openObs,
}) {
  const region = document.createElement("section");
  region.className = "deckWidgetRegion";
  region.setAttribute("aria-label", "Status widgets");
  const tools = document.createElement("div");
  tools.className = "deckWidgetTools";
  const grid = document.createElement("div");
  grid.className = "deckWidgetGrid";
  const notice = document.createElement("p");
  notice.className = "deckEditorNotice";
  notice.setAttribute("role", "status");
  region.append(tools, notice, grid);
  (host.querySelector(".deckWorkspace") || host.querySelector(".deckGrid")).before(region);
  const editor = createWidgetEditor({ getConfig, save, explain, getSnapshot: () => snapshot }),
    cards = new Map();
  let signature = "",
    snapshot,
    editing = false,
    connected = true,
    timer,
    closed = false,
    dragging = "",
    busy = false;
  const button = (label, fn) => {
    const n = document.createElement("button");
    n.type = "button";
    n.textContent = label;
    n.onclick = () => void work(fn);
    return n;
  };
  async function work(fn) {
    if (busy) return;
    busy = true;
    region.inert = true;
    try {
      await fn();
      notice.textContent = "";
    } catch (e) {
      notice.textContent = explain(e);
    } finally {
      busy = false;
      region.inert = false;
      paint();
    }
  }
  async function change(fn) {
    const config = structuredClone(getConfig());
    fn(config.widgets);
    await save(config);
  }
  async function move(id, before) {
    return change((w) => {
      const at = w.items.findIndex((r) => r.id === id);
      if (at < 0) return;
      const [row] = w.items.splice(at, 1);
      const to = w.items.findIndex((r) => r.id === before);
      w.items.splice(to < 0 ? w.items.length : to, 0, row);
    });
  }
  async function mark(description, control, done) {
    if (editing || busy) return;
    control.disabled = true;
    control.dataset.pending = "true";
    control.textContent = "Saving…";
    busy = true;
    try {
      await request("/api/control-deck/timestamps", "POST", { description });
      done();
      notice.textContent = "Moment saved.";
      await refresh();
    } catch (e) {
      notice.textContent = explain(e);
    } finally {
      busy = false;
      control.dataset.pending = "false";
      control.textContent = "+ Mark moment";
      paint();
    }
  }
  async function exportMoments() {
    const value = await request("/api/control-deck/timestamps");
    const body = value.items
      .map(
        (row) =>
          new Date(row.at).toISOString() +
          " · " +
          row.positionSeconds +
          "s · " +
          row.description +
          (row.url ? "\n" + row.url : ""),
      )
      .join("\n\n");
    const url = URL.createObjectURL(new Blob([body], { type: "text/plain;charset=utf-8" })),
      a = document.createElement("a");
    a.href = url;
    a.download = "RaveLink-stream-timestamps.txt";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function draw() {
    const config = getConfig().widgets,
      key = JSON.stringify([config, editing]);
    if (key === signature) return;
    signature = key;
    tools.replaceChildren();
    grid.replaceChildren();
    cards.clear();
    if (editing) {
      tools.append(button("+ Add widget", () => editor.open(null)));
      const columns = document.createElement("select");
      columns.setAttribute("aria-label", "Maximum widgets per row");
      for (let i = 1; i <= 6; i++) columns.add(new Option("Up to " + i + " per row", i));
      columns.value = config.columns;
      columns.onchange = () =>
        void work(() =>
          change((w) => {
            w.columns = Number(columns.value);
          }),
        );
      tools.append(columns);
      for (const [key, label] of [
        ["enabled", "Show widgets"],
        ["fullscreen", "Show in fullscreen"],
      ]) {
        const item = document.createElement("label");
        item.className = "deckCheck";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = config[key];
        input.onchange = () =>
          void work(() =>
            change((w) => {
              w[key] = input.checked;
            }),
          );
        item.append(input, document.createTextNode(label));
        tools.append(item);
      }
      const presets = document.createElement("select");
      presets.setAttribute("aria-label", "Widget starter set");
      presets.add(new Option("Add a starter set…", ""));
      for (const [key, label] of [
        ["music", "Music & requests"],
        ["stream", "Stream dashboard"],
        ["minimal", "Clock & connections"],
      ])
        presets.add(new Option(label, key));
      presets.onchange = () =>
        void work(async () => {
          const types =
            {
              music: ["now-playing", "queue", "next-request"],
              stream: ["stream", "audience", "clips", "markers", "obs"],
              minimal: ["clock", "connections"],
            }[presets.value] || [];
          await change((w) => {
            w.enabled = true;
            for (const type of types)
              if (!w.items.some((r) => r.type === type) && w.items.length < 24)
                w.items.push({ id: deckId(), type });
          });
        });
      tools.append(presets);
    }
    for (const widget of config.items) {
      const card = createWidgetCard(widget, { editing, mark, exportMoments, openTwitch, openObs });
      cards.set(widget.id, card);
      if (editing) {
        const controls = document.createElement("span");
        controls.className = "deckWidgetEditTools";
        const index = config.items.findIndex((r) => r.id === widget.id);
        const edit = button("Edit", () => editor.open(widget)),
          previous = button("←", () => move(widget.id, config.items[index - 1]?.id)),
          next = button("→", () => move(widget.id, config.items[index + 2]?.id)),
          remove = button("×", () =>
            change((w) => {
              w.items = w.items.filter((r) => r.id !== widget.id);
            }),
          );
        previous.disabled = index === 0;
        next.disabled = index === config.items.length - 1;
        previous.setAttribute(
          "aria-label",
          "Move " + (widget.title || widgetNames[widget.type]) + " earlier",
        );
        next.setAttribute(
          "aria-label",
          "Move " + (widget.title || widgetNames[widget.type]) + " later",
        );
        remove.setAttribute("aria-label", "Remove " + (widget.title || widgetNames[widget.type]));
        controls.append(edit, previous, next, remove);
        card.header.append(controls);
        card.root.draggable = true;
        card.root.ondragstart = () => {
          dragging = widget.id;
        };
        card.root.ondragover = (e) => e.preventDefault();
        card.root.ondrop = (e) => {
          e.preventDefault();
          if (dragging && dragging !== widget.id) void work(() => move(dragging, widget.id));
          dragging = "";
        };
      }
      grid.append(card.root);
    }
    region.hidden = !(editing || (config.enabled && config.items.length));
    region.dataset.fullscreen = String(config.fullscreen);
    resize();
  }
  function resize() {
    const config = getConfig()?.widgets;
    if (!config) return;
    const width = region.clientWidth,
      columns = width < 520 ? 1 : width < 900 ? Math.min(2, config.columns) : config.columns;
    grid.style.gridTemplateColumns = "repeat(" + columns + ",minmax(0,1fr))";
    for (const row of config.items)
      if (cards.has(row.id))
        cards.get(row.id).root.style.gridColumn = "span " + Math.min(columns, row.span);
  }
  function paint() {
    if (!snapshot) return;
    for (const card of cards.values())
      card.update(snapshot.widgetData || {}, Date.now(), connected);
  }
  function sync() {
    clearInterval(timer);
    timer = null;
    if (
      !closed &&
      visible() &&
      region.getClientRects().length &&
      getConfig()?.widgets?.enabled &&
      cards.size
    )
      timer = setInterval(paint, 1000);
  }
  const resizeObserver = new ResizeObserver(resize),
    observer = new IntersectionObserver(sync);
  resizeObserver.observe(region);
  observer.observe(region);
  document.addEventListener("visibilitychange", sync);
  return {
    update(next, isEditing, isConnected = true) {
      if (!next.config.widgets) {
        region.hidden = true;
        return;
      }
      snapshot = next;
      editing = isEditing;
      connected = isConnected;
      draw();
      paint();
      sync();
    },
    close() {
      closed = true;
      clearInterval(timer);
      resizeObserver.disconnect();
      observer.disconnect();
    },
    resume() {
      closed = false;
      resizeObserver.observe(region);
      observer.observe(region);
      sync();
    },
  };
}
