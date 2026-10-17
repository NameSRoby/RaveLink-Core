/**
 * Feature navigation.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#request-security-and-the-feature-ui-relay
 */
const views = new Map();
const themeKeys = [
  "bg",
  "panel",
  "surface",
  "accent",
  "edge",
  "text",
  "muted",
  "ok",
  "warn",
  "bad",
];
function present(frame) {
  const style = getComputedStyle(document.documentElement);
  const theme = Object.fromEntries(
    themeKeys.map((key) => [key, style.getPropertyValue(`--${key}`).trim()]),
  );
  const developerMode = document.documentElement.dataset.developerMode === "true";
  frame.contentWindow.postMessage(
    {
      channel: "ravelink-feature-ui-v1",
      type: "presentation",
      theme,
      developerMode,
    },
    location.origin,
  );
  requestAnimationFrame(() => {
    const wrapper = frame.contentDocument;
    if (!wrapper) return;
    wrapper.documentElement.style.background = "transparent";
    if (wrapper.body) wrapper.body.style.background = "transparent";
    const surface = wrapper.getElementById("surface");
    if (surface) surface.style.background = "transparent";
  });
}
window.addEventListener("message", (event) => {
  if (event.origin !== location.origin || event.data?.channel !== "ravelink-feature-ui-v1") return;
  for (const [id, view] of views) {
    const frame = [...view.panel.querySelectorAll(".featurePageFrame")].find(
      (item) => item.contentWindow === event.source,
    );
    if (!frame) continue;
    if (event.data.type === "feature-ready") {
      frame.dataset.ready = "true";
      present(frame);
      if (frame.playlistStart) {
        frame.contentWindow.postMessage(frame.playlistStart, location.origin);
        frame.playlistStart = null;
      }
    }
    if (event.data.type === "feature-height" && Number.isFinite(event.data.height))
      frame.style.height = `${Math.max(240, Math.min(16000, Math.ceil(event.data.height)))}px`;
    if (event.data.type === "feature-open") {
      if (
        id === "song-request" &&
        frame.dataset.pageId === "server-playlist" &&
        event.data.pageId === "player" &&
        event.data.startPlayback === true &&
        ["youtube", "soundcloud"].includes(event.data.provider)
      )
        view.startPlaylist(event.data.provider);
      else openFeaturePage(id, event.data.pageId);
    }
    if (
      event.data.type === "feature-call-complete" &&
      event.data.featureId === id &&
      /^[a-z][a-z0-9.]{1,79}$/.test(event.data.capability) &&
      /^[a-z][a-z0-9-]{0,39}$/.test(event.data.method)
    ) {
      window.dispatchEvent(
        new CustomEvent("ravelink:feature-call-complete", {
          detail: {
            featureId: id,
            capability: event.data.capability,
            method: event.data.method,
          },
        }),
      );
    }
    break;
  }
});
new MutationObserver(() =>
  views.forEach((view) => view.panel.querySelectorAll(".featurePageFrame").forEach(present)),
).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ["style", "data-developer-mode"],
});

export function openFeaturePage(featureId, pageId) {
  const view = views.get(featureId);
  if (!view) return;
  selectMainTab(view.tab.dataset.tab);
  view.open(pageId);
}

export function selectMainTab(key) {
  document.querySelectorAll("[data-tab]").forEach((button) => {
    const selected = button.dataset.tab === key;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-selected", String(selected));
  });
  document.querySelectorAll("[data-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.panel !== key;
  });
}

export function syncFeatureNavigation(features) {
  // A workspace is useful only while its package is running and contributes
  // at least one page. Disabled/crashed packages remain manageable in Packages,
  // and backend-only payloads never become empty tabs.
  const visibleFeatures = features.filter(
    (feature) => feature.lifecycle === "active" && (feature.uiContributions || []).length > 0,
  );
  const ids = new Set(visibleFeatures.map((row) => row.id));
  for (const [id, view] of views) {
    if (ids.has(id)) continue;
    if (!view.panel.hidden) selectMainTab("features");
    view.tab.remove();
    view.panel.remove();
    views.delete(id);
  }
  for (const feature of visibleFeatures) {
    const signature = JSON.stringify([
      feature.version,
      feature.pid,
      feature.lifecycle,
      feature.uiContributions,
    ]);
    let view = views.get(feature.id);
    if (!view) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "tabButton";
      tab.dataset.tab = `feature:${feature.id}`;
      const panel = document.createElement("section");
      panel.className = "panel featureWorkspace";
      panel.dataset.panel = tab.dataset.tab;
      panel.hidden = true;
      const moreNav = document.getElementById("moreNav");
      document.getElementById("tabs").insertBefore(tab, moreNav || null);
      document.querySelector('[data-panel="features"]').after(panel);
      view = { tab, panel, signature: "", open: () => {} };
      tab.onclick = () => {
        selectMainTab(tab.dataset.tab);
        view.open();
      };
      views.set(feature.id, view);
    }
    view.tab.textContent = feature.name.toUpperCase();
    if (view.signature === signature) continue;
    view.signature = signature;
    view.panel.replaceChildren();
    const heading = document.createElement("h2");
    heading.textContent = feature.name.toUpperCase();
    view.panel.append(heading);
    const tabs = document.createElement("nav");
    tabs.className = "tabs featureSubtabs";
    tabs.setAttribute("aria-label", `${feature.name} views`);
    const surface = document.createElement("div");
    const overlayTools = document.createElement("div");
    overlayTools.className = "overlaySourceTools";
    overlayTools.hidden = true;
    const overlayLabel = document.createElement("label");
    overlayLabel.textContent = "OBS BROWSER SOURCE URL";
    const overlayUrl = document.createElement("input");
    overlayUrl.readOnly = true;
    overlayLabel.append(overlayUrl);
    const copyOverlayUrl = document.createElement("button");
    copyOverlayUrl.type = "button";
    copyOverlayUrl.textContent = "COPY URL";
    copyOverlayUrl.dataset.tooltip = "Copy the clean overlay address for an OBS Browser Source.";
    const overlaySizeLabel = document.createElement("label");
    overlaySizeLabel.textContent = "OBS SOURCE SIZE";
    const overlaySize = document.createElement("input");
    overlaySize.readOnly = true;
    overlaySize.value = "1280 x 720";
    overlaySizeLabel.append(overlaySize);
    const overlayNotice = document.createElement("span");
    overlayNotice.className = "statusLine";
    copyOverlayUrl.onclick = async () => {
      try {
        await navigator.clipboard.writeText(overlayUrl.value);
        overlayNotice.textContent = "URL COPIED";
        overlayNotice.className = "statusLine ok";
      } catch {
        overlayUrl.select();
        overlayNotice.textContent = "SELECTED // PRESS CTRL+C";
        overlayNotice.className = "statusLine warn";
      }
    };
    overlayTools.append(overlayLabel, overlaySizeLabel, copyOverlayUrl, overlayNotice);
    const frames = new Map();
    let selected = "";
    const open = (page) => {
      selected = page.id;
      overlayTools.hidden = page.surface !== "overlay";
      if (page.surface === "overlay") {
        const sourceUrl = new URL(
          `/features-ui/${encodeURIComponent(feature.id)}/${encodeURIComponent(page.id)}`,
          location.origin,
        );
        sourceUrl.searchParams.set("v", feature.version);
        overlayUrl.value = sourceUrl.href;
        overlayNotice.textContent =
          feature.id === "song-request" && page.id === "obs-overlay"
            ? "SET WIDTH 1280 // HEIGHT 720 // KEEP SCALE 100%"
            : "PASTE THIS URL INTO OBS";
        overlayNotice.className = "statusLine";
      }
      let frame = frames.get(page.id);
      if (!frame) {
        frame = document.createElement("iframe");
        frame.className = "featurePageFrame";
        frame.dataset.pageId = page.id;
        if (feature.id === "song-request" && page.id === "player") frame.allow = "autoplay";
        frame.title = `${feature.name}: ${page.title}`;
        frame.referrerPolicy = "no-referrer";
        // The host wrapper contains the existing opaque-origin contribution sandbox.
        frame.src = `/features-ui/${encodeURIComponent(feature.id)}/${encodeURIComponent(page.id)}`;
        surface.append(frame);
        frames.set(page.id, frame);
      }
      frames.forEach((item, id) => {
        item.hidden = id !== page.id;
      });
      [...tabs.children].forEach((button) => {
        const active = button.dataset.page === page.id;
        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", String(active));
      });
    };
    const pages = feature.uiContributions || [];
    for (const page of pages) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "tabButton";
      button.dataset.page = page.id;
      button.textContent = page.title;
      button.onclick = () => open(page);
      tabs.append(button);
    }
    view.startPlaylist = (provider) => {
      const page = pages.find((row) => row.id === "player");
      if (!page) return;
      selectMainTab(view.tab.dataset.tab);
      open(page);
      const frame = frames.get("player"),
        message = {
          channel: "ravelink-feature-ui-v1",
          type: "playlist-start",
          provider,
        };
      if (frame.dataset.ready === "true") frame.contentWindow.postMessage(message, location.origin);
      else frame.playlistStart = message;
    };
    view.panel.append(tabs, overlayTools, surface);
    view.open = (pageId) => {
      const requested = pages.find((page) => page.id === pageId);
      if (requested) open(requested);
      else if (!selected && pages.length) open(pages[0]);
    };
    if (!view.panel.hidden) view.open();
  }
}
