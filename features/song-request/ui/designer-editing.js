/** Local editing commands and bounded history. Never writes the published OBS
 * configuration; Save overlay remains the only apply operation.
 */
/* exported OverlayDesignerEditing, setupEditingWorkspace, addSelectionTools, rememberSelectionFocus */
const OverlayDesignerEditing = (() => {
  let states = [],
    index = -1,
    replaying = false,
    gesture = null,
    lastGroup = "",
    lastAt = 0;
  let serial = 0;
  const serialize = () => JSON.stringify(config);
  const snapshot = () => ({
    value: serialize(),
    shape: selectedShapeId,
    piece: selectedPreviewPiece,
  });
  function buttons() {
    if (!$("edit-undo")) return;
    const blocked = document.querySelector("main").inert;
    $("edit-undo").disabled = blocked || index <= 0;
    $("edit-redo").disabled = blocked || index >= states.length - 1;
    const dirty = baseline !== null && serialize() !== baseline;
    $("edit-state").textContent = dirty ? "Unsaved changes" : "Saved";
    $("edit-state").dataset.dirty = String(dirty);
  }
  function record() {
    if (baseline === null || replaying || gesture) return;
    const value = serialize();
    if (states[index]?.value === value) {
      Object.assign(states[index], snapshot());
      return buttons();
    }
    const input = document.activeElement;
    const group = input?.matches('input[type="range"],input[type="number"]')
      ? input.id || input.dataset.geometry || ""
      : "";
    const at = performance.now();
    const coalesce =
      group && group === lastGroup && at - lastAt < 450 && index > 0 && index === states.length - 1;
    states = states.slice(0, index + 1);
    if (coalesce) states[index] = snapshot();
    else {
      states.push(snapshot());
      index++;
    }
    while (
      states.length > 40 ||
      (states.length > 1 && states.reduce((n, s) => n + s.value.length, 0) > 1048576)
    ) {
      states.shift();
      index--;
    }
    lastGroup = group;
    lastAt = at;
    buttons();
  }
  function apply(value) {
    replaying = true;
    try {
      config = JSON.parse(value.value);
      selectedShapeId = value.shape;
      selectedPreviewPiece = value.piece;
      inspectedPiece = null;
      if (!config.segments.some((s) => s.id === selectedShapeId)) selectedShapeId = "";
      if (!config.segments.some((s) => s.blocks.some((b) => b.id === selectedPreviewPiece)))
        selectedPreviewPiece = "";
      sync();
    } finally {
      replaying = false;
      buttons();
    }
  }
  function travel(delta) {
    if (
      document.querySelector("main").inert ||
      gesture ||
      index + delta < 0 ||
      index + delta >= states.length
    )
      return;
    index += delta;
    lastGroup = "";
    apply(states[index]);
    status(
      delta < 0 ? "Edit undone. Save overlay to apply." : "Edit restored. Save overlay to apply.",
    );
  }
  function duplicate() {
    if (document.querySelector("main").inert) return;
    const target = canvasTarget();
    if (!target) return;
    const row = config.segments.find((s) => s.blocks.includes(target));
    const count = config.segments.reduce((n, s) => n + s.blocks.length, 0);
    if ((!row && config.segments.length >= 8) || count + (row ? 1 : target.blocks.length) > 32)
      return status("This design supports up to eight shapes and 32 information pieces.");
    begin();
    enableCanvas();
    const copy = structuredClone(canvasTarget());
    const id = () => "copy-" + Date.now().toString(36) + "-" + (++serial).toString(36);
    copy.id = id();
    if (copy.blocks) for (const b of copy.blocks) b.id = id();
    const parent = row?.frame || config;
    copy.frame.x = bounded(copy.frame.x + 12, 0, Math.max(0, parent.width - copy.frame.width));
    copy.frame.y = bounded(copy.frame.y + 12, 0, Math.max(0, parent.height - copy.frame.height));
    if (row) {
      row.blocks.splice(row.blocks.indexOf(target) + 1, 0, copy);
      selectedPreviewPiece = copy.id;
    } else {
      copy.name = ((copy.name || "Shape") + " copy").slice(0, 40);
      config.segments.splice(config.segments.indexOf(target) + 1, 0, copy);
      selectedShapeId = copy.id;
      selectedPreviewPiece = "";
    }
    changed(true);
    finish();
    status("Duplicated. Drag the copy into place, or use arrow keys.");
    focusCanvasTarget();
  }
  function begin() {
    if (!gesture) {
      record();
      gesture = snapshot();
    }
  }
  function finish(cancel = false) {
    const prior = gesture;
    gesture = null;
    lastGroup = "";
    if (cancel && prior) apply(prior);
    else record();
  }
  return {
    record,
    duplicate,
    begin,
    finish,
    refresh: buttons,
    reset() {
      states = [];
      index = -1;
      lastGroup = "";
    },
    undo: () => travel(-1),
    redo: () => travel(1),
    get zoom() {
      const input = $("edit-zoom");
      return input?.value === "fit" || !input ? null : Number(input.value);
    },
  };
})();
function addSelectionTools(panel, row) {
  const duplicate = node("button", "", "Duplicate");
  duplicate.id = "canvas-duplicate";
  duplicate.title = "Duplicate the selection (Ctrl+D)";
  duplicate.onclick = () => OverlayDesignerEditing.duplicate();
  panel.append(duplicate);
  if (!selectedPreviewPiece) {
    const name = node("input");
    name.value = row.name || "Shape";
    name.maxLength = 40;
    name.dataset.editName = "shape";
    name.onchange = () => {
      row.name = name.value.trim() || "Shape";
      changed(true);
    };
    panel.append(labeled("Shape name", name));
    const visible = node("input");
    visible.type = "checkbox";
    visible.checked = row.enabled;
    visible.onchange = () => {
      row.enabled = visible.checked;
      changed(true);
    };
    const show = node("label", "switchLabel");
    show.append(visible, node("span", "", "Show shape"));
    panel.append(show);
  }
}
function rememberSelectionFocus() {
  const active = document.activeElement;
  const key = ["geometry", "constraint", "editName"].find((k) => active?.dataset[k]);
  if (canvasGesture || !key || !active.closest("#canvas-inspector")) return () => {};
  const value = active.dataset[key];
  return () => {
    const replacement = [...$("canvas-inspector").querySelectorAll("input")].find(
      (el) => el.dataset[key] === value,
    );
    replacement?.focus({ preventScroll: true });
  };
}
function setupEditingWorkspace() {
  const actions = document.querySelector("header > div");
  const history = node("div", "edit-history");
  for (const [id, label, title, run] of [
    ["edit-undo", "Undo", "Undo the last edit (Ctrl+Z)", OverlayDesignerEditing.undo],
    [
      "edit-redo",
      "Redo",
      "Restore the next edit (Ctrl+Shift+Z or Ctrl+Y)",
      OverlayDesignerEditing.redo,
    ],
  ]) {
    const button = node("button", "", label);
    button.id = id;
    button.title = title;
    button.onclick = run;
    history.append(button);
  }
  const state = node("span", "edit-state");
  state.id = "edit-state";
  history.append(state);
  actions.prepend(history);
  $("discard").textContent = "Discard draft";
  $("discard").title = "Discard all local changes and load the latest saved overlay.";
  const left = document.querySelector(".left");
  const area = node("div", "designer-canvas-area");
  const objects = $("canvas-library");
  const dock = node("section", "selection-dock");
  dock.id = "selection-dock";
  document.querySelector(".designer-sidebar").prepend(dock);
  dock.append($("canvas-inspector"), $("selection-inspector"));
  area.append(...left.children);
  left.append(objects, area);
  objects.setAttribute("aria-label", "Overlay objects");
  const zoom = select(["fit", "0.5", "0.75", "1", "1.5", "2"], "fit", () => renderPreview());
  zoom.id = "edit-zoom";
  for (const option of zoom.options)
    option.textContent = option.value === "fit" ? "Fit" : Number(option.value) * 100 + "%";
  document.querySelector(".preview-heading").append(labeled("Zoom", zoom));
  document.addEventListener("keydown", (event) => {
    const typing = event.target.closest("input,select,textarea,[contenteditable=true]");
    if (typing || event.defaultPrevented || document.querySelector("main").inert || canvasGesture)
      return;
    const key = event.key.toLowerCase(),
      command = event.ctrlKey || event.metaKey;
    if (command && ["z", "y", "d"].includes(key)) {
      event.preventDefault();
      if (key === "d") OverlayDesignerEditing.duplicate();
      else if (key === "y" || event.shiftKey) OverlayDesignerEditing.redo();
      else OverlayDesignerEditing.undo();
    } else if (event.key === "Escape") {
      selectedPreviewPiece = "";
      selectedShapeId = "";
      updatePieceInspector();
    } else if (event.key === "Delete" && canvasTarget()) {
      event.preventDefault();
      $("canvas-delete")?.click();
    }
  });
  OverlayDesignerEditing.record();
  updatePieceInspector();
}
