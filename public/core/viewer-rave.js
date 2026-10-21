/** Viewer-facing Rave setup uses existing operator policy, never grants audio
 * access or starts capture. Read fresh state before saving a single preference.
 */
export function initViewerRave({ request, getFixtures }) {
  const $ = (id) => document.getElementById(id);
  const toggle = $("viewerRaveEnabled"),
    status = $("viewerRaveStatus");
  let busy = false;
  async function refresh() {
    if (busy) return;
    busy = true;
    toggle.disabled = true;
    try {
      const [music, effects] = await Promise.all([
        request("/api/music-to-light/operator"),
        request("/twitch/light-effects"),
      ]);
      const view = music.value;
      toggle.checked = view.design.raveEnabled;
      const missing = [];
      if (!view.design.raveEnabled) missing.push("Turn on Allow viewers to start Rave above.");
      if (!effects.enabled)
        missing.push("Enable Dynamic color commands and save its settings below.");
      if (!view.captureAvailable)
        missing.push("The audio helper is unavailable; open Music-to-Light Setup.");
      if (!view.status.permissions.capture || !view.status.permissions.output)
        missing.push("Allow audio capture and live lighting in Music-to-Light Setup.");
      if (!view.status.sourceSelected)
        missing.push("Choose a music app and optional fallbacks in Music-to-Light Setup.");
      const eligible = new Set(
        getFixtures()
          .filter((f) => f.enabled !== false && f.twitchEnabled === true)
          .map((f) => f.id),
      );
      const selected = new Set(
        view.bindings.fixtures.filter((f) => eligible.has(f.id)).map((f) => f.id),
      );
      const routed = (effects.fixtureIds || []).filter((id) => selected.has(id));
      if (!routed.length)
        missing.push("Route at least one music light in Dynamic color commands below, then save.");
      status.textContent = missing.length
        ? missing.join(" ")
        : `Ready for Rave requests on ${routed.length} routed light${routed.length === 1 ? "" : "s"}. Redeem Change my lights with rave as the input.`;
    } catch (error) {
      status.textContent = error.message;
    } finally {
      busy = false;
      toggle.disabled = false;
    }
  }
  toggle.onchange = async () => {
    if (busy) return;
    const enabled = toggle.checked;
    busy = true;
    toggle.disabled = true;
    try {
      const { value } = await request("/api/music-to-light/operator");
      await request("/api/music-to-light/call", {
        method: "POST",
        body: JSON.stringify({
          capability: "music.styles.v1",
          method: "configure",
          payload: { ...value.design, raveEnabled: enabled },
        }),
      });
      status.textContent = enabled ? "Rave permission saved." : "Viewer Rave is off.";
    } catch (error) {
      toggle.checked = !enabled;
      status.textContent = error.message;
    } finally {
      busy = false;
      toggle.disabled = false;
    }
    await refresh();
  };
  $("viewerRaveRefresh").onclick = refresh;
  $("viewerRaveSetup").onclick = () => {
    document.querySelector('[data-light-tab="music"]').click();
    document.querySelector('[data-music-view-target="setup"]').click();
  };
  document.querySelector('[data-light-tab="viewer"]').addEventListener("click", refresh);
  return { refresh };
}
