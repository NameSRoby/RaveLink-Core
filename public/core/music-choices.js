/** Compact, keyboard-accessible choices for short lists. Native selects remain
 * the single bound value; long application and saved-look lists stay native.
 */
(() => {
  const groups = new Map();
  function sync(select) {
    const group = groups.get(select);
    if (!group) return;
    if (select.disabled && group.contains(document.activeElement))
      group.dataset.pendingFocus = select.value;
    const options = [...select.options].filter((o) => !o.disabled || o.selected);
    const key = options.map((o) => [o.value, o.textContent].join(":")).join("|");
    if (group.dataset.options !== key) {
      group.dataset.options = key;
      group.replaceChildren(
        ...options.map((option) => {
          const button = document.createElement("button");
          button.type = "button";
          button.dataset.value = option.value;
          button.textContent = option.textContent;
          button.title = option.title || select.title;
          button.onclick = () => {
            select.value = option.value;
            select.dispatchEvent(new Event("change", { bubbles: true }));
            syncAll();
          };
          return button;
        }),
      );
    }
    for (const button of group.children) {
      const option = [...select.options].find((o) => o.value === button.dataset.value);
      const active = button.dataset.value === select.value;
      button.disabled = select.disabled || option.disabled;
      button.setAttribute("aria-pressed", String(active));
      button.tabIndex = active || !select.value ? 0 : -1;
    }
    if (!select.disabled && group.dataset.pendingFocus) {
      if (document.activeElement === document.body || group.contains(document.activeElement))
        [...group.children]
          .find((b) => b.dataset.value === group.dataset.pendingFocus)
          ?.focus({ preventScroll: true });
      delete group.dataset.pendingFocus;
    }
  }
  function enhance(select) {
    if (groups.has(select)) return;
    const group = document.createElement("div");
    group.className =
      select.dataset.musicChoice === "tiles" ? "musicChoiceTiles" : "musicSegmented";
    group.setAttribute("role", "group");
    group.setAttribute(
      "aria-label",
      select.getAttribute("aria-label") ||
        select.parentElement.firstChild?.textContent?.trim() ||
        "Choose an option",
    );
    select.hidden = true;
    select.setAttribute("aria-hidden", "true");
    select.tabIndex = -1;
    select.after(group);
    group.onkeydown = (event) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key))
        return;
      const buttons = [...group.children].filter((b) => !b.disabled);
      if (!buttons.length) return;
      const index = buttons.indexOf(document.activeElement);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? buttons.length - 1
            : (index +
                (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) +
                buttons.length) %
              buttons.length;
      event.preventDefault();
      buttons[next].click();
      buttons[next].focus();
    };
    groups.set(select, group);
    sync(select);
  }
  function syncAll() {
    document.querySelectorAll("[data-music-controls] select[data-music-choice]").forEach(enhance);
    for (const select of groups.keys())
      if (select.isConnected) sync(select);
      else groups.delete(select);
  }
  globalThis.RaveLinkMusicChoices = { enhance, sync: syncAll };
})();
