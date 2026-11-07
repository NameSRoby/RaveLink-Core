/** Screen-only wake protection for the visible fullscreen deck. No host power changes. */
export function createDeckAwake({ document: doc = document, navigator: nav = navigator, onState }) {
  let wanted = false,
    enabled = true,
    generation = 0,
    lock = null,
    pending = false,
    video = null;
  const visible = () => wanted && enabled && doc.visibilityState === "visible";
  const report = (state) => onState?.(state);
  function release() {
    generation++;
    const previous = lock;
    lock = null;
    if (previous) void previous.release().catch(() => {});
    video?.pause();
    report(enabled ? "idle" : "off");
  }
  function fallback() {
    if (video) return video;
    video = doc.createElement("video");
    video.setAttribute("playsinline", "");
    video.setAttribute("aria-hidden", "true");
    video.tabIndex = -1;
    video.style.cssText =
      "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;bottom:0;left:0";
    video.disablePictureInPicture = true;
    for (const event of ["pause", "error", "ended"])
      video.addEventListener(event, () => {
        if (visible()) report("blocked");
      });
    video.addEventListener("loadedmetadata", () => {
      video.loop = video.duration <= 1;
    });
    video.addEventListener("timeupdate", () => {
      if (video.duration > 1 && video.currentTime > 0.5) video.currentTime = 0;
    });
    for (const type of ["webm", "mp4"]) {
      const source = doc.createElement("source");
      source.src = new URL(`./wake-media/silent.${type}`, import.meta.url).href;
      source.type = `video/${type}`;
      video.append(source);
    }
    doc.body.append(video);
    return video;
  }
  async function acquire() {
    if (!visible() || lock || pending) return;
    pending = true;
    const ticket = generation;
    report("requesting");
    try {
      if (nav.wakeLock?.request) {
        const acquired = await nav.wakeLock.request("screen");
        if (ticket !== generation || !visible()) {
          await acquired.release();
          return;
        }
        lock = acquired;
        acquired.addEventListener("release", () => {
          if (lock !== acquired) return;
          lock = null;
          if (visible()) report("blocked");
        });
        report("active");
      } else {
        await fallback().play();
        if (ticket !== generation || !visible()) video.pause();
        else report("fallback");
      }
    } catch {
      if (ticket === generation && visible()) report("blocked");
    } finally {
      pending = false;
      // A new fullscreen session may have begun while an old request was settling.
      if (ticket !== generation && visible()) void acquire();
    }
  }
  doc.addEventListener("visibilitychange", () => {
    if (visible()) void acquire();
    else release();
  });
  doc.defaultView.addEventListener("pagehide", () => {
    wanted = false;
    release();
  });
  return {
    enter() {
      wanted = true;
      void acquire();
    },
    leave() {
      wanted = false;
      release();
    },
    toggle() {
      enabled = !enabled;
      if (enabled) void acquire();
      else release();
    },
    retry() {
      void acquire();
    },
    get enabled() {
      return enabled;
    },
  };
}
