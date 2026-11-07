import { deckScreens } from "./control-deck-screen-layout.js";
/** Fullscreen screens reuse the real buttons; swiping never executes one. */
export function createDeckPager({
  host,
  getConfig,
  getPageId = () => getConfig()?.pages?.[0]?.id,
  onPage,
  onSwipe = () => {},
}) {
  const grid = host.querySelector(".deckGrid"),
    bar = document.createElement("nav"),
    previous = document.createElement("button"),
    next = document.createElement("button"),
    count = document.createElement("span");
  bar.className = "deckScreenNav";
  bar.setAttribute("aria-label", "Fullscreen screens");
  bar.hidden = true;
  previous.type = next.type = "button";
  previous.textContent = "‹";
  next.textContent = "›";
  previous.setAttribute("aria-label", "Previous screen");
  next.setAttribute("aria-label", "Next screen");
  count.setAttribute("aria-live", "polite");
  bar.append(previous, count, next);
  host.append(bar);
  let index = 0,
    groups = [[]],
    total = 1,
    frame,
    gesture,
    suppressUntil = 0;
  const mixerChannels = () =>
    host.dataset.mixerPage === "true"
      ? host.querySelector(".deckInlineMixer:not([hidden]) .deckMixerChannels")
      : null;
  const buttons = () =>
    [...(mixerChannels()?.children || grid.querySelectorAll("[data-deck-button]"))].filter(
      (item) => item.dataset.filtered !== "true",
    );
  const enabled = () =>
    host.dataset.focus === "true" &&
    (getConfig()?.layout?.fullscreenMode === "pages" ||
      getConfig()?.layout?.fullscreenSwipe ||
      getConfig()?.layout?.fullscreenKeyboard);
  const pageIndex = () =>
    Math.max(
      0,
      (getConfig()?.pages || []).findIndex((page) => page.id === getPageId()),
    );
  function paint() {
    const list = buttons();
    total = groups.length;
    index = Math.max(0, Math.min(total - 1, index));
    list.forEach((button) => {
      button.dataset.screenHidden = String(enabled() && !groups[index].includes(button));
      button.hidden = button.dataset.screenHidden === "true";
    });
    const pages = getConfig()?.pages || [],
      at = pageIndex();
    bar.hidden = !enabled() || (total <= 1 && pages.length <= 1);
    previous.disabled = index === 0 && (!onPage || at === 0);
    next.disabled = index === total - 1 && (!onPage || at === pages.length - 1);
    count.textContent =
      (pages.length > 1 ? (pages[at]?.name || `Page ${at + 1}`) + " · " : "") +
      `${index + 1} / ${total}`;
    if (document.activeElement?.closest?.("[data-deck-button][hidden]")) next.focus();
  }
  function measure() {
    frame = null;
    const list = buttons();
    const channels = mixerChannels();
    if (channels) channels.dataset.paged = String(enabled());
    host.dataset.paged = String(enabled());
    grid.style.removeProperty("grid-template-columns");
    for (const button of list) {
      button.hidden = false;
      button.dataset.screenHidden = "false";
      button.style.removeProperty("max-width");
    }
    if (!enabled() || !list.length) {
      index = 0;
      groups = [list];
      paint();
      return;
    }
    bar.hidden = false;
    if (channels) {
      const style = getComputedStyle(channels),
        gap = parseFloat(style.gap) || 0,
        width =
          channels.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        cardWidth = Math.max(...list.map((item) => item.getBoundingClientRect().width)),
        columns = Math.max(1, Math.floor((width + gap + 0.5) / (cardWidth + gap)));
      channels.scrollLeft = 0;
      groups = [];
      for (let at = 0; at < list.length; at += columns) groups.push(list.slice(at, at + columns));
      paint();
      return;
    }
    const style = getComputedStyle(grid),
      gap = parseFloat(style.gap) || 0,
      chosenColumns = style.gridTemplateColumns.split(" ").filter(Boolean).length,
      width = grid.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      columns = Math.max(1, Math.min(chosenColumns, Math.floor((width + gap + 0.5) / (52 + gap)))),
      rack = host.querySelector(".deckSliderRack:not([hidden])"),
      bottomDock =
        rack &&
        host.dataset.sliderOrientation === "horizontal" &&
        host.dataset.sliderDock !== "start"
          ? rack.getBoundingClientRect().height +
            (parseFloat(getComputedStyle(rack.parentElement).gap) || 0)
          : 0,
      available = Math.max(
        64,
        Math.min(innerHeight, bar.getBoundingClientRect().top) -
          grid.getBoundingClientRect().top -
          parseFloat(style.paddingTop) -
          Math.min(6, parseFloat(style.paddingBottom) || 0) -
          bottomDock,
      ),
      aspect = getComputedStyle(list[0]).aspectRatio.split("/").map(Number),
      ratio = aspect[0] / (aspect[1] || 1) || 1;
    grid.style.gridTemplateColumns = `repeat(${columns},minmax(0,1fr))`;
    for (const button of list) button.style.maxWidth = `${available * ratio}px`;
    host.style.setProperty("--deck-page-room", available + "px");
    host.style.setProperty(
      "--deck-page-fader",
      Math.max(48, Math.min(156, available - 130)) + "px",
    );
    groups = deckScreens(
      list.map((element) => ({
        element,
        height: element.getBoundingClientRect().height,
      })),
      columns,
      available,
      gap,
    );
    paint();
  }
  function schedule() {
    if (!frame) frame = requestAnimationFrame(measure);
  }
  function move(delta) {
    if (!enabled()) return;
    if ((index + delta < 0 || index + delta >= total) && onPage) {
      const page = getConfig()?.pages?.[pageIndex() + (delta < 0 ? -1 : 1)];
      if (page) {
        index = delta < 0 ? Number.MAX_SAFE_INTEGER : 0;
        onPage(page.id);
        schedule();
        return;
      }
    }
    index += delta;
    paint();
  }
  previous.onclick = () => move(-1);
  next.onclick = () => move(1);
  const observer = new MutationObserver(schedule);
  observer.observe(grid, { childList: true });
  observer.observe(host, { attributes: true, attributeFilter: ["data-focus"] });
  const resize = new ResizeObserver(schedule);
  resize.observe(host);
  resize.observe(grid);
  host.addEventListener("ravelink-deck-mixer-layout", schedule);
  const widgets = host.querySelector(".deckWidgetRegion");
  if (widgets) resize.observe(widgets);
  addEventListener("resize", schedule);
  host.addEventListener(
    "pointerdown",
    (event) => {
      if (
        !enabled() ||
        !getConfig()?.layout?.fullscreenSwipe ||
        event.pointerType !== "touch" ||
        !event.isPrimary ||
        event.target.closest(
          "input:not([type=range]),select,textarea,.deckScreenNav,.deckExitFullscreen,.deckKeepAwake",
        )
      )
        return;
      gesture = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        at: performance.now(),
        target: event.target,
        dragging: false,
      };
    },
    true,
  );
  host.addEventListener("pointermove", (event) => {
    if (!gesture || gesture.id !== event.pointerId) return;
    if (event.target.closest('input[data-touch-adjusting="true"]')) {
      gesture = null;
      return;
    }
    const dx = event.clientX - gesture.x,
      dy = event.clientY - gesture.y;
    if (!gesture.dragging && Math.abs(dy) > 14 && Math.abs(dy) > Math.abs(dx) * 1.4) {
      gesture = null;
      return;
    }
    if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.15) {
      if (!gesture.dragging) {
        gesture.dragging = true;
        onSwipe();
        host.setPointerCapture(event.pointerId);
      }
    }
  });
  function end(event) {
    if (!gesture || gesture.id !== event.pointerId) return;
    const held = gesture;
    gesture = null;
    if (held.dragging) {
      suppressUntil = performance.now() + 500;
      const distance = Math.abs(event.clientX - held.x),
        speed = distance / Math.max(1, performance.now() - held.at);
      if (event.type === "pointerup" && (distance >= 36 || (distance >= 20 && speed >= 0.25)))
        move(event.clientX < held.x ? 1 : -1);
    }
  }
  host.addEventListener("pointerup", end, true);
  host.addEventListener("pointercancel", end, true);
  host.addEventListener(
    "click",
    (event) => {
      if (
        event.detail > 0 &&
        performance.now() < suppressUntil &&
        !event.target.closest(".deckScreenNav")
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true,
  );
  return {
    move,
    schedule,
    reveal(tile) {
      if (!enabled()) return;
      const at = buttons().indexOf(tile);
      if (at >= 0) {
        index = Math.max(
          0,
          groups.findIndex((group) => group.includes(tile)),
        );
        paint();
      }
    },
  };
}
