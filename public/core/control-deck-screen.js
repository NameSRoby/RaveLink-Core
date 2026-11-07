/** One decoded image/video, clipped to real button faces. Gaps stay transparent. */
export function createDeckScreen(host) {
  const layer = document.createElement("div");
  layer.className = "deckScreenMedia";
  layer.hidden = true;
  layer.setAttribute("aria-hidden", "true");
  host.prepend(layer);
  let media = null,
    id = "",
    settings = null,
    frame = null,
    visible = true;
  function playback() {
    if (media?.tagName !== "VIDEO") return;
    if (
      visible &&
      !layer.hidden &&
      !document.hidden &&
      host.getClientRects().length &&
      settings?.mediaId
    )
      void media.play().catch(() => {
        host.dataset.screenState = "playback-blocked";
      });
    else media.pause();
  }
  function measure() {
    frame = null;
    if (!settings?.mediaId) return;
    const root = host.getBoundingClientRect(),
      tiles = [...host.querySelectorAll("[data-deck-button]")].filter(
        (tile) => !tile.hidden && tile.getClientRects().length,
      ),
      rects = tiles
        .map((tile) => {
          const r = tile.getBoundingClientRect(),
            clip = tile.closest(".deckMixerChannels")?.getBoundingClientRect();
          const x = clip ? Math.max(r.left, clip.left) : r.left,
            y = r.top,
            right = clip ? Math.min(r.right, clip.right) : r.right;
          return {
            x: x - root.left + host.scrollLeft,
            y: y - root.top + host.scrollTop,
            w: Math.max(0, right - x),
            h: r.height,
            r: parseFloat(getComputedStyle(tile).borderRadius) || 0,
          };
        })
        .filter((rect) => rect.w > 0 && rect.h > 0);
    if (!rects.length) {
      layer.hidden = true;
      playback();
      return;
    }
    const x = Math.min(...rects.map((r) => r.x)),
      y = Math.min(...rects.map((r) => r.y)),
      w = Math.max(...rects.map((r) => r.x + r.w)) - x,
      h = Math.max(...rects.map((r) => r.y + r.h)) - y;
    layer.style.left = x + "px";
    layer.style.top = y + "px";
    layer.style.width = w + "px";
    layer.style.height = h + "px";
    const mask = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${rects.map((r) => `<rect x="${r.x - x}" y="${r.y - y}" width="${r.w}" height="${r.h}" rx="${Math.min(r.r, r.w / 2, r.h / 2)}" fill="white"/>`).join("")}</svg>`;
    layer.style.maskImage = `url("data:image/svg+xml;base64,${btoa(mask)}")`;
    layer.hidden = false;
    playback();
  }
  function schedule() {
    if (settings?.mediaId && !frame) frame = requestAnimationFrame(measure);
  }
  const observer = new MutationObserver((records) => {
    if (records.some((record) => !layer.contains(record.target))) schedule();
  });
  observer.observe(host, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["hidden", "data-focus", "data-editing"],
  });
  new ResizeObserver(schedule).observe(host);
  new IntersectionObserver((entries) => {
    visible = entries.some((entry) => entry.isIntersecting);
    playback();
  }).observe(host);
  document.addEventListener("visibilitychange", playback);
  host.addEventListener("pointermove", schedule);
  addEventListener("pagehide", () => {
    visible = false;
    playback();
  });
  addEventListener("pageshow", () => {
    visible = true;
    schedule();
  });
  return {
    update(value) {
      settings = value;
      host.dataset.screenMedia = String(!!value?.mediaId);
      layer.style.opacity = (value?.brightness ?? 70) / 100;
      if (!value?.mediaId) {
        media?.pause?.();
        if (media) {
          media.removeAttribute("src");
          media.load?.();
          layer.replaceChildren();
          media = null;
          id = "";
        }
        layer.hidden = true;
        return;
      }
      if (id !== value.mediaId) {
        media?.pause?.();
        id = value.mediaId;
        media = document.createElement(/\.(mp4|webm)$/.test(id) ? "video" : "img");
        media.src = "/api/control-deck/media/" + encodeURIComponent(id);
        if (media.tagName === "VIDEO") {
          media.muted = true;
          media.loop = true;
          media.playsInline = true;
          media.preload = "metadata";
        } else media.alt = "";
        media.addEventListener("error", () => {
          host.dataset.screenState = "media-unavailable";
        });
        layer.replaceChildren(media);
      }
      media.style.objectFit = value.fit;
      schedule();
      playback();
    },
  };
}
