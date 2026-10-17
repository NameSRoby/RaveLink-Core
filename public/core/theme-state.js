/**
 * Theme state.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#request-security-and-the-feature-ui-relay
 */
window.createSharedThemeSaver = function (onFailure) {
  let themeSaveTimer,
    themeSavePending = null,
    themeSaving = false,
    retryAt = 0;
  function schedule() {
    clearTimeout(themeSaveTimer);
    themeSaveTimer = setTimeout(flushSharedTheme, Math.max(250, retryAt - Date.now()));
  }
  function saveSharedTheme(value) {
    themeSavePending = value;
    schedule();
  }
  async function flushSharedTheme() {
    if (themeSaving || !themeSavePending) return;
    if (Date.now() < retryAt) {
      schedule();
      return;
    }
    const theme = themeSavePending;
    themeSavePending = null;
    themeSaving = true;
    try {
      const response = await fetch("/api/presentation/theme", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ theme }),
      });
      if (response.status === 429) {
        retryAt =
          Date.now() +
          Math.max(1, Math.min(120, Number(response.headers.get("retry-after")) || 60)) * 1000;
        themeSavePending ||= theme;
      } else if (!response.ok) throw new Error("theme_save_failed");
      else retryAt = 0;
    } catch {
      onFailure();
    } finally {
      themeSaving = false;
      if (themeSavePending) schedule();
    }
  }

  return saveSharedTheme;
};
