/**
 * Shared designer and OBS rendering engine.
 * DOM replacement is separate from clock/progress updates. Retain marquee identity
 * across unchanged metadata so playback ticks do not restart scrolling. Measure text
 * overflow after layout and wait for fonts where needed. Visibility timers are per
 * stage; one preview must not hide or reset another rendered overlay.
 */
// One renderer is embedded into both the designer and the OBS page at build time.
(function (root) {
  const visibility = new WeakMap();
  const resizeObservers = new WeakMap();
  const providerColors = {
    youtube: "#ff6978",
    tidal: "#c3d6f2",
    soundcloud: "#ff9655",
    spotify: "#6ed9aa",
    "apple-music": "#fa819c",
  };
  function trackVisibility(stage, config, current) {
    const item = current.candidate || current,
      key = JSON.stringify([item.provider, item.providerItemId, item.title, item.artists]),
      old = visibility.get(stage);
    const pausedSince =
      current.status === "paused"
        ? old?.key === key && old.status === "paused"
          ? old.pausedSince
          : Date.now()
        : 0;
    visibility.set(stage, { key, status: current.status, pausedSince, config });
  }
  function updateVisibility(stage) {
    const state = visibility.get(stage);
    if (!state) return;
    const c = state.config,
      preview = stage.id === "preview" && stage.dataset.testVisibility !== "true";
    const hidden =
      !preview &&
      ((c.hidePaused &&
        state.status === "paused" &&
        Date.now() - state.pausedSince >= (c.pauseHideSeconds || 5) * 1000) ||
        (c.hideStopped && state.status === "stopped") ||
        (c.hideLoading && state.status === "loading"));
    stage.classList.toggle("behavior-hidden", Boolean(hidden));
    stage.setAttribute("aria-hidden", String(Boolean(hidden)));
  }
  const sizes = { small: 10, medium: 14, large: 19, display: 27 },
    artSizes = { small: 52, medium: 80, large: 110, display: 150 };
  const fonts = {
    system:
      '"Segoe UI","Yu Gothic UI",Meiryo,"Microsoft YaHei UI","Malgun Gothic",Arial,sans-serif',
    serif: 'Georgia,"Yu Mincho",serif',
    mono: 'Consolas,"MS Gothic",monospace',
    cjk: '"Yu Gothic UI",Meiryo,"Microsoft YaHei UI",sans-serif',
  };
  const node = (tag, cls, text) => {
    const n = document.createElement(tag);
    n.className = cls || "";
    if (text !== undefined) n.textContent = String(text);
    return n;
  };
  const rgba = (hex, opacity) =>
    "rgba(" +
    [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(",") +
    "," +
    opacity / 100 +
    ")";
  const clock = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  };
  function clockData(n, current) {
    n.dataset.playbackClock = "";
    n.dataset.position = String(current.positionMs || 0);
    n.dataset.duration = String(current.durationMs || 0);
    n.dataset.observed = String(current.observedAt || Date.now());
    n.dataset.status = current.status || "";
    return n;
  }
  function update(stage) {
    updateVisibility(stage);
    stage.querySelectorAll("[data-playback-clock]").forEach((n) => {
      const d = n.dataset,
        duration = Number(d.duration),
        base = Number(d.position),
        position = Math.min(
          duration || Infinity,
          base + (d.status === "playing" ? Math.max(0, Date.now() - Number(d.observed)) : 0),
        );
      if (n.classList.contains("playbackTime"))
        n.textContent = duration
          ? (visibility.get(stage)?.config.remainingTime
              ? "-" + clock(Math.ceil(Math.max(0, duration - position) / 1000) * 1000)
              : clock(position)) +
            " / " +
            clock(duration)
          : "";
      else
        n.style.width = duration
          ? Math.min(100, Math.max(0, (position / duration) * 100)) + "%"
          : "0%";
    });
  }
  function block(raw, item, current, next, config) {
    let n;
    const kind = raw.kind;
    if (kind === "label") n = node("div", "label", "NOW PLAYING");
    else if (kind === "title") {
      n = node("div", "titleViewport title");
      const track = node("div", "marqueeTrack");
      track.append(node("h1", "", item.title || "Untitled"));
      n.append(track);
    } else if (kind === "artists") n = node("p", "artists muted", (item.artists || []).join(", "));
    else if (kind === "album") {
      if (!item.album) return null;
      n = node("p", "album muted", item.album);
    } else if (kind === "artwork") {
      n = node("div", "artwork");
      if (item.artworkUrl) {
        const img = node("img");
        img.src = item.artworkUrl;
        img.alt = "";
        img.referrerPolicy = "no-referrer";
        n.append(img);
      }
    } else if (kind === "provider")
      n = node(
        "div",
        "provider",
        String(item.provider || current.provider || current.source || "").toUpperCase(),
      );
    else if (kind === "meta" || kind === "time") {
      n = node("div", "meta");
      if (kind === "meta")
        n.append(
          node(
            "span",
            "",
            String(item.provider || current.provider || current.source || "").toUpperCase(),
          ),
        );
      n.append(clockData(node("span", "playbackTime"), current));
    } else if (kind === "progress") {
      n = node("div", "bar progress");
      n.append(clockData(node("span", "playbackProgress"), current));
    } else if (kind === "queue") {
      if (!next.length) return null;
      n = node("div", "queue", "NEXT  //  " + next.slice(0, raw.count || 3).join("  /  "));
    } else return null;
    n.classList.add("block", "pv");
    n.dataset.blockId = raw.id;
    if (config.layoutMode === "canvas" && raw.frame) place(n, raw.frame);
    const s = raw.style || {},
      target = kind === "title" ? n.querySelector("h1") : n;
    if (s.align) {
      n.style.textAlign = s.align;
      if (kind === "title") n.dataset.textAlign = s.align;
    }
    if (sizes[s.size]) {
      if (kind === "artwork")
        n.style.setProperty("--oart", (artSizes[s.size] * config.scale) / 100 + "px");
      else if (kind === "progress")
        n.style.height = { small: 2, medium: 4, large: 7, display: 10 }[s.size] + "px";
      else target.style.fontSize = (sizes[s.size] * config.scale) / 100 + "px";
    }
    if (fonts[s.font]) target.style.fontFamily = fonts[s.font];
    if (s.color) {
      target.style.color = s.color;
      if (kind === "progress") n.firstElementChild.style.background = s.color;
    }
    if (s.bold) target.style.fontWeight = "800";
    if (s.italic) target.style.fontStyle = "italic";
    if (s.uppercase) target.style.textTransform = "uppercase";
    return n;
  }
  function marquee(stage) {
    if (!stage.classList.contains("title-scroll")) return;
    stage.querySelectorAll(".titleViewport").forEach((view) => {
      const track = view.firstElementChild,
        title = track?.firstElementChild,
        width = Math.ceil(title?.scrollWidth || 0),
        available = view.clientWidth;
      if (!available || !width) return;
      const measurement = available + ":" + width;
      if (view.dataset.marqueeReady === measurement) return;
      view.dataset.marqueeReady = measurement;
      view.classList.remove("scrolling");
      track.querySelectorAll("[aria-hidden]").forEach((n) => n.remove());
      if (width <= available + 1) return;
      const gap = Math.max(28, available * 0.12),
        distance = width + gap,
        copy = title.cloneNode(true);
      copy.setAttribute("aria-hidden", "true");
      track.append(copy);
      view.style.setProperty("--marquee-gap", gap + "px");
      view.style.setProperty("--marquee-distance", distance + "px");
      view.style.setProperty("--marquee-duration", Math.max(8, distance / 32) + "s");
      view.classList.add("scrolling");
    });
  }
  function place(n, f) {
    n.classList.add("positioned");
    Object.assign(n.style, {
      left: f.x + "px",
      top: f.y + "px",
      width: f.width + "px",
      height: f.height + "px",
    });
  }
  function render(stage, config, current, rows = [], theme = {}, options = {}) {
    const c = { ...config };
    if (c.followAppColors !== false) {
      for (const [key, source] of Object.entries({
        accent: "accent",
        surface: "surface",
        text: "text",
        muted: "muted",
      }))
        if (/^#[0-9a-f]{6}$/i.test(theme[source] || "")) c[key] = theme[source];
    }
    const provider = (current.candidate || current).provider;
    if (c.providerColors && providerColors[provider]) c.accent = providerColors[provider];
    trackVisibility(stage, c, current);
    const vars = {
      owidth: c.width + "px",
      oheight: c.height + "px",
      oscale: c.scale / 100,
      ogap: c.gap + "px",
      obgap: c.blockGap + "px",
      opad: c.padding + "px",
      oradius: c.radius + "px",
      oedge: c.accentWidth + "px",
      oshadow: c.shadow / 100,
      oaccent: c.accent,
      osurface: rgba(c.surface, c.opacity),
      otext: c.text,
      omuted: c.muted,
      ofont: fonts[c.font] || fonts.system,
      oart: ((c.artworkSize || 110) * c.scale) / 100 + "px",
      oborder: (c.borderWidth || 0) + "px",
      oborderColor: c.borderColor || c.accent,
    };
    for (const [key, value] of Object.entries(vars)) stage.style.setProperty("--" + key, value);
    const idClass = stage.id === "preview" ? "preview" : "stage";
    stage.className =
      idClass +
      " song-overlay skin-" +
      (c.skin || "classic") +
      " " +
      c.flow +
      " " +
      c.anchor +
      " content-" +
      c.contentAlign +
      " edge-" +
      (c.accentPosition || "left") +
      " title-" +
      (c.titleMode || "scroll") +
      (c.separated ? " separated" : "") +
      (c.autoHeight ? "" : " height-fixed");
    stage.classList.toggle("canvas-layout", c.layoutMode === "canvas");
    const item = current.candidate || current,
      next = rows.filter((r) => r.id !== current.entryId).map((r) => r.candidate?.title || r.query);
    stage.replaceChildren(
      ...c.segments
        .filter((s) => s.enabled)
        .map((s) => {
          const n = node(
            "section",
            "segment preview-segment " +
              s.direction +
              " " +
              s.size +
              " align-" +
              s.align +
              (s.wrap === false ? " no-wrap" : ""),
          );
          n.dataset.segmentId = s.id;
          n.append(...s.blocks.map((b) => block(b, item, current, next, c)).filter(Boolean));
          const style = s.style || {};
          if (style.surface || (style.opacity !== null && style.opacity !== undefined))
            n.style.background = rgba(style.surface || c.surface, style.opacity ?? c.opacity);
          if (style.accent) n.style.borderLeftColor = style.accent;
          for (const [key, prop] of Object.entries({
            padding: "padding",
            radius: "borderRadius",
            accentWidth: "borderLeftWidth",
          }))
            if (style[key] !== null && style[key] !== undefined) n.style[prop] = style[key] + "px";
          if (style.accentWidth) n.style.borderLeftStyle = "solid";
          return n;
        })
        .filter((n) => n.childElementCount || c.layoutMode === "canvas"),
    );
    if (c.layoutMode === "canvas") {
      // Empty shapes are useful surfaces and must also be visible in OBS.
      for (const s of c.segments.filter((s) => s.enabled)) {
        let n = [...stage.children].find((n) => n.dataset.segmentId === s.id);
        if (!n) {
          n = node("section", "segment preview-segment");
          n.dataset.segmentId = s.id;
          stage.append(n);
        }
        if (s.frame) place(n, s.frame);
        n.classList.add("shape-" + (s.shape || "rectangle"));
        if (s.style?.surface || !s.blocks.length)
          n.style.background = rgba(s.style?.surface || c.surface, s.style?.opacity ?? c.opacity);
      }
      // Restore layer order even when some surfaces contain no information.
      for (const s of c.segments) {
        const n = [...stage.children].find((n) => n.dataset.segmentId === s.id);
        if (n) stage.append(n);
      }
    }
    resizeObservers.get(stage)?.disconnect();
    const observer = new ResizeObserver(() => marquee(stage));
    resizeObservers.set(stage, observer);
    stage.querySelectorAll(".titleViewport").forEach((n) => observer.observe(n));
    document.fonts?.ready.then(() => marquee(stage));
    if (options.animate && c.motion !== "off") stage.classList.add(c.motion);
    stage.classList.toggle("hidden", !stage.childElementCount);
    update(stage);
    requestAnimationFrame(() => requestAnimationFrame(() => marquee(stage)));
  }
  root.SongOverlayRenderer = {
    render,
    update,
    marquee,
    clockData,
    observe: trackVisibility,
    reset: (stage) => visibility.delete(stage),
  };
})(window);
