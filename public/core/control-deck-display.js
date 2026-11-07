/** Fit each tile to its own size. Color/status polling never restarts display cycles. */
export function createDeckDisplay(host) {
  let frame = 0,
    closed = false,
    measurements = new WeakMap();
  function fit() {
    frame = 0;
    for (const tile of host.querySelectorAll("[data-deck-button]")) {
      const own = tile.dataset.textMode || "auto",
        global = host.dataset.display || "auto";
      const mode =
        global === "per-button" || (global === "auto" && !["auto", "image-text"].includes(own))
          ? own
          : global;
      const title = tile.querySelector(".deckButtonTitle"),
        icon = tile.querySelector(".deckButtonSymbol,.deckButtonImage"),
        slider = tile.querySelector(".deckVolumeSlider");
      const key = [
        mode,
        tile.clientWidth,
        tile.clientHeight,
        title?.textContent,
        tile.querySelector(".deckButtonState")?.textContent,
        host.style.getPropertyValue("--deck-label-scale"),
        host.dataset.showStatus,
      ].join("|");
      if (measurements.get(tile) === key) continue;
      measurements.set(tile, key);
      tile.dataset.compact = "false";
      tile.dataset.displayMode = mode === "auto" || slider ? "image-text" : mode;
      if (slider) {
        tile.dataset.compact = String(tile.clientWidth < 140);
        continue;
      }
      if (mode !== "auto" || tile.clientWidth === 0) continue;
      if (tile.clientWidth < 80 && icon) {
        tile.dataset.displayMode = "image";
        continue;
      }
      const clipped =
        tile.scrollHeight > tile.clientHeight + 1 ||
        (title && title.scrollHeight > title.clientHeight + 1);
      if (clipped && title && icon) tile.dataset.displayMode = "alternate";
      else if (!icon) tile.dataset.displayMode = "text";
    }
  }
  function schedule() {
    if (!closed && !frame) frame = requestAnimationFrame(fit);
  }
  const resize = new ResizeObserver(schedule);
  resize.observe(host.querySelector(".deckGrid"));
  const changes = new MutationObserver(schedule);
  changes.observe(host, { attributes: true, attributeFilter: ["data-display"] });
  document.fonts?.ready.then(() => {
    measurements = new WeakMap();
    schedule();
  });
  return {
    schedule,
    close() {
      closed = true;
      cancelAnimationFrame(frame);
      frame = 0;
      resize.disconnect();
      changes.disconnect();
    },
    resume() {
      closed = false;
      resize.observe(host.querySelector(".deckGrid"));
      changes.observe(host, { attributes: true, attributeFilter: ["data-display"] });
      schedule();
    },
  };
}
