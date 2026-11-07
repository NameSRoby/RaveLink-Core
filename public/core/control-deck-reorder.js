/** Pointer reordering previews the complete layout without saving until drop. */
export function createDeckReorder({ host, enabled, moveButton, note, suppressClick }) {
  let dragCleanup;
  function start(event, button) {
    if (
      !enabled() ||
      event.button !== 0 ||
      event.isPrimary === false ||
      event.target.closest(".deckRemoveButton")
    )
      return;
    dragCleanup?.();
    const capture = event.currentTarget;
    try {
      capture.setPointerCapture(event.pointerId);
    } catch {
      /* Synthetic tests may not own a native pointer. */
    }
    const x = event.clientX,
      y = event.clientY;
    const grid = host.querySelector(".deckGrid");
    const slots = [...grid.children].map((el) => ({
      el,
      rect: el.getBoundingClientRect(),
    }));
    const restore = () => {
      for (const slot of slots) grid.append(slot.el);
    };
    let moved = false,
      targetId,
      ghost,
      scrollFrame = 0,
      lastX = x,
      lastY = y,
      source = host.querySelector(`[data-deck-button="${CSS.escape(button.id)}"]`);
    let scroller = source?.parentElement;
    while (
      scroller &&
      !(
        scroller.scrollHeight > scroller.clientHeight + 1 &&
        /auto|scroll/.test(getComputedStyle(scroller).overflowY)
      )
    )
      scroller = scroller.parentElement;
    scroller ||= document.scrollingElement;
    const clearMarks = () =>
      host.querySelectorAll("[data-drop]").forEach((el) => delete el.dataset.drop);
    const preview = () => {
      if (!ghost && source) {
        ghost = source.cloneNode(true);
        ghost.classList.add("deckDragGhost");
        ghost.removeAttribute("data-deck-button");
        ghost.style.width = source.offsetWidth + "px";
        ghost.style.height = source.offsetHeight + "px";
        ghost.setAttribute("aria-hidden", "true");
        grid.append(ghost);
        source.dataset.dragging = "true";
        note(
          "Moving “" +
            button.title +
            "”. Drop before the highlighted button; other buttons shift along.",
        );
      }
      if (ghost) {
        ghost.style.left = Math.min(lastX + 14, innerWidth - ghost.offsetWidth - 8) + "px";
        ghost.style.top = Math.min(lastY + 14, innerHeight - ghost.offsetHeight - 8) + "px";
      }
      clearMarks();
      restore();
      for (const slot of slots) slot.rect = slot.el.getBoundingClientRect();
      const target = slots.find(
        ({ rect }) =>
          lastX >= rect.left && lastX <= rect.right && lastY >= rect.top && lastY <= rect.bottom,
      )?.el;
      const targetButton = target?.querySelector("[data-deck-button]") || target;
      targetId = targetButton ? targetButton.dataset.deckButton || "" : undefined;
      if (target && target !== source.closest(".deckTile")) {
        targetButton.dataset.drop = "true";
        grid.insertBefore(source.closest(".deckTile"), target);
      }
    };
    const scroll = () => {
      scrollFrame = 0;
      const bounds =
        scroller === document.scrollingElement
          ? { top: 0, bottom: innerHeight }
          : scroller.getBoundingClientRect();
      const top = Math.max(0, bounds.top),
        bottom = Math.min(innerHeight, bounds.bottom);
      const delta =
        lastY < top + 56
          ? -Math.min(12, (top + 56 - lastY) / 4)
          : lastY > bottom - 56
            ? Math.min(12, (lastY - bottom + 56) / 4)
            : 0;
      const before = scroller.scrollTop;
      if (delta) scroller.scrollTop += delta;
      if (scroller.scrollTop !== before) {
        preview();
        scrollFrame = requestAnimationFrame(scroll);
      }
    };
    const move = (e) => {
      if (!moved && Math.hypot(e.clientX - x, e.clientY - y) < 8) return;
      moved = true;
      e.preventDefault();
      lastX = e.clientX;
      lastY = e.clientY;
      preview();
      if (!scrollFrame) scrollFrame = requestAnimationFrame(scroll);
    };
    const cleanup = () => {
      cancelAnimationFrame(scrollFrame);
      try {
        capture.releasePointerCapture(event.pointerId);
      } catch {
        /* Pointer may already have ended. */
      }
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", cancel);
      clearMarks();
      if (moved) restore();
      ghost?.remove();
      if (source) delete source.dataset.dragging;
      dragCleanup = null;
    };
    const end = () => {
      cleanup();
      if (moved) {
        suppressClick();
        if (targetId !== undefined) moveButton(button.id, targetId);
      }
    };
    const cancel = () => {
      cleanup();
      if (moved) suppressClick();
    };
    dragCleanup = cancel;
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", cancel);
  }
  return { start, cancel: () => dragCleanup?.() };
}
