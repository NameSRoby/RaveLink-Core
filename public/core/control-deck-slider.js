/** Local drag feedback stays smooth while bounded writes coalesce to the latest value. */
const controls = new WeakMap();
export const sliderControl = (input) => controls.get(input);
export function sliderIncrement(layout = {}, appearance = {}, base = 1) {
  const enabled =
    appearance.sliderSnap === "on" || (appearance.sliderSnap !== "off" && layout.sliderSnap);
  return enabled
    ? Math.max(
        base,
        appearance.sliderSnap === "on"
          ? appearance.sliderIncrement || 5
          : layout.sliderIncrement || 5,
      )
    : base;
}
export function appendDeckSlider(tile, button, spec, send, layout) {
  for (const key of ["sliderOrientation", "sliderStyle"])
    tile.dataset[key] = button.appearance[key] === "inherit" ? layout[key] : button.appearance[key];
  const input = document.createElement("input"),
    output = document.createElement("output"),
    track = document.createElement("div");
  input.className = "deckVolumeSlider";
  input.type = "range";
  input.min = spec.min ?? 0;
  input.max = spec.max ?? 100;
  input.step = spec.step ?? 1;
  input.dataset.increment = sliderIncrement(layout, button.appearance, Number(input.step));
  input.value = button.steps[0].params?.[spec.parameter || "level"] ?? 50;
  input.setAttribute("aria-label", button.title);
  output.className = "deckSliderValue";
  track.className = "deckFaderTrack";
  track.append(input);
  tile.append(track, output);
  return bindDeckSlider({ input, output, send });
}
export function bindDeckSlider({ input, output, send, onError = () => {}, interval = 120 }) {
  let dragging = false,
    pointerDown = false,
    dirty = false,
    flight = false,
    timer,
    idleTimer,
    latest = Number(input.value),
    sent = null,
    protectUntil = 0,
    lastSentAt = 0,
    touch = null,
    activePointer = null,
    editor = null,
    closed = false;
  const paint = () => {
    output.textContent = input.value + "%";
    input.style.setProperty("--slider-level", input.value + "%");
    const min = Number(input.min) || 0,
      max = Number(input.max) || 100;
    input.parentElement?.style.setProperty(
      "--slider-level",
      Math.max(0, Math.min(100, ((Number(input.value) - min) / (max - min)) * 100)) + "%",
    );
  };
  async function flush() {
    clearTimeout(timer);
    timer = null;
    if (closed || flight || !dirty) return;
    flight = true;
    dirty = false;
    sent = latest;
    lastSentAt = Date.now();
    protectUntil = Date.now() + 1800;
    try {
      const ok = await send(sent);
      if (ok === false) throw Error("slider_change_unconfirmed");
    } catch (error) {
      protectUntil = 0;
      onError(error);
    } finally {
      flight = false;
      if (dirty && !closed)
        timer = setTimeout(flush, Math.max(0, interval - (Date.now() - lastSentAt)));
    }
  }
  function changed() {
    const min = Number(input.min) || 0,
      max = Number(input.max) || 100,
      increment = Number(input.dataset.increment) || Number(input.step) || 1,
      raw = Number(input.value),
      nearest = Math.max(min, Math.min(max, min + Math.round((raw - min) / increment) * increment));
    input.value = String(Math.abs(max - raw) <= Math.abs(nearest - raw) ? max : nearest);
    dirty = dirty || Number(input.value) !== latest;
    latest = Number(input.value);
    protectUntil = Date.now() + 1800;
    paint();
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!pointerDown) dragging = false;
    }, 200);
    if (!flight && !timer)
      timer = setTimeout(flush, Math.max(0, interval - (Date.now() - lastSentAt)));
  }
  input.addEventListener("pointerdown", (event) => {
    activePointer = event.pointerId;
    window.addEventListener("pointerup", releasePointer, true);
    window.addEventListener("pointercancel", releasePointer, true);
    if (event.pointerType === "touch") {
      event.preventDefault();
      const surface = input.closest("[data-slider-orientation],.deckWindowsPanel"),
        vertical =
          (surface?.dataset.sliderOrientation || surface?.dataset.orientation || "horizontal") ===
          "vertical";
      touch = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        value: Number(input.value),
        vertical,
        locked: false,
        abandoned: false,
        after: performance.now() + (!vertical && input.closest('[data-paged="true"]') ? 200 : 0),
      };
      input.setPointerCapture?.(event.pointerId);
    }
    pointerDown = dragging = true;
    input.dataset.dragging = "true";
    clearTimeout(idleTimer);
  });
  for (const event of ["touchstart", "touchmove"])
    input.addEventListener(event, (e) => e.preventDefault(), { passive: false });
  input.addEventListener("pointermove", (event) => {
    if (!touch || touch.id !== event.pointerId || touch.abandoned) return;
    const along = touch.vertical ? touch.y - event.clientY : event.clientX - touch.x,
      across = touch.vertical ? event.clientX - touch.x : touch.y - event.clientY;
    if (Math.hypot(along, across) > 8) touch.moved = true;
    if (!touch.locked) {
      if (
        (Math.abs(across) > 8 && Math.abs(across) > Math.abs(along) * 1.15) ||
        (Math.abs(along) > 8 && performance.now() < touch.after)
      ) {
        touch.abandoned = true;
        delete input.dataset.dragging;
        return;
      }
      if (Math.abs(along) < 6 || Math.abs(along) < Math.abs(across) * 1.15) return;
      touch.locked = true;
      input.dataset.touchAdjusting = "true";
    }
    event.preventDefault();
    const bounds = input.getBoundingClientRect(),
      min = Number(input.min) || 0,
      max = Number(input.max) || 100,
      step = Number(input.step) || 1,
      travel = Math.max(1, (touch.vertical ? bounds.height : bounds.width) - 16),
      value = Math.max(min, Math.min(max, touch.value + (along / travel) * (max - min)));
    input.value = String(min + Math.round((value - min) / step) * step);
    changed();
  });
  input.addEventListener("input", changed);
  input.addEventListener("keydown", (event) => {
    const increment = Number(input.dataset.increment) || Number(input.step) || 1;
    if (
      increment <= Number(input.step) ||
      !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
    )
      return;
    event.preventDefault();
    const min = Number(input.min) || 0,
      max = Number(input.max) || 100,
      value = Number(input.value),
      up = ["ArrowUp", "ArrowRight"].includes(event.key);
    input.value = String(
      event.key === "Home"
        ? min
        : event.key === "End"
          ? max
          : Math.max(
              min,
              Math.min(
                max,
                min +
                  (up
                    ? Math.floor((value - min) / increment) + 1
                    : Math.ceil((value - min) / increment) - 1) *
                    increment,
              ),
            ),
    );
    changed();
  });
  input.addEventListener("change", () => {
    dragging = false;
    changed();
    void flush();
  });
  function releasePointer(event) {
    if (event?.pointerId !== undefined && event.pointerId !== activePointer) return;
    if (event?.type === "pointerup" && touch && !touch.locked && !touch.abandoned && !touch.moved) {
      const bounds = input.getBoundingClientRect(),
        min = Number(input.min) || 0,
        max = Number(input.max) || 100,
        travel = Math.max(1, (touch.vertical ? bounds.height : bounds.width) - 16),
        distance = touch.vertical
          ? bounds.bottom - event.clientY - 8
          : event.clientX - bounds.left - 8;
      input.value = String(Math.max(min, Math.min(max, min + (distance / travel) * (max - min))));
      changed();
    }
    pointerDown = dragging = false;
    activePointer = null;
    touch = null;
    window.removeEventListener("pointerup", releasePointer, true);
    window.removeEventListener("pointercancel", releasePointer, true);
    delete input.dataset.touchAdjusting;
    delete input.dataset.dragging;
    clearTimeout(idleTimer);
    if (dirty) void flush();
  }
  input.addEventListener("blur", () => releasePointer());
  function exactValue() {
    if (input.disabled || closed || editor) return;
    editor = document.createElement("input");
    editor.type = "number";
    editor.inputMode = "numeric";
    editor.className = "deckSliderExact";
    editor.min = input.min;
    editor.max = input.max;
    editor.step = input.step;
    editor.value = input.value;
    editor.setAttribute(
      "aria-label",
      (input.getAttribute("aria-label") || "Volume") + " exact percent",
    );
    output.hidden = true;
    output.after(editor);
    const finish = (commit) => {
      if (!editor) return;
      if (commit && (!editor.value || !editor.reportValidity())) return;
      const value = editor.value,
        field = editor;
      editor = null;
      field.remove();
      output.hidden = false;
      if (commit) {
        input.value = value;
        changed();
        void flush();
      }
    };
    editor.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (["Enter", "Escape"].includes(event.key)) {
        event.preventDefault();
        finish(event.key === "Enter");
      }
    });
    editor.addEventListener("blur", () => finish(true));
    editor.focus({ preventScroll: true });
    editor.select();
  }
  output.tabIndex = 0;
  output.setAttribute("role", "button");
  output.title = "Set exact volume";
  output.addEventListener("click", (event) => {
    event.stopPropagation();
    exactValue();
  });
  output.addEventListener("keydown", (event) => {
    if (["Enter", " "].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      exactValue();
    }
  });
  const control = {
    sync(value) {
      if (!Number.isFinite(value)) return;
      if (
        !editor &&
        !dragging &&
        !dirty &&
        !flight &&
        (value === latest || Date.now() >= protectUntil)
      ) {
        input.value = value;
        latest = value;
        paint();
      }
    },
    close() {
      closed = true;
      releasePointer();
      editor?.remove();
      editor = null;
      output.hidden = false;
      delete input.dataset.dragging;
      delete input.dataset.touchAdjusting;
      touch = null;
      clearTimeout(timer);
      clearTimeout(idleTimer);
    },
    cancel() {
      dirty = false;
      releasePointer();
      dragging = pointerDown = false;
      delete input.dataset.dragging;
      delete input.dataset.touchAdjusting;
      touch = null;
      clearTimeout(timer);
      timer = null;
      clearTimeout(idleTimer);
    },
  };
  controls.set(input, control);
  paint();
  return control;
}
