/**
 * Playlist browser.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#playlist-transfers-and-uncertain-writes
 */
window.installPlaylistBrowser = function installPlaylistBrowser(
  select,
  label,
  { multiple = false } = {},
) {
  const root = document.createElement("section");
  root.id = select.id + "Browser";
  root.className = "playlistBrowser";
  root.setAttribute("aria-label", label);
  const input = document.createElement("input");
  input.type = "search";
  input.placeholder = "Search loaded playlists";
  input.setAttribute("aria-label", "Search " + label);
  const list = document.createElement("div");
  list.className = "playlistBrowserRows";
  const footer = document.createElement("div");
  footer.className = "playlistBrowserFooter";
  const previous = document.createElement("button"),
    next = document.createElement("button"),
    count = document.createElement("span");
  previous.type = next.type = "button";
  previous.textContent = "Previous";
  next.textContent = "Next";
  footer.append(previous, count, next);
  root.append(input, list, footer);
  const selected = new Set(),
    tools = document.createElement("div"),
    all = document.createElement("button"),
    clear = document.createElement("button"),
    summary = document.createElement("span");
  tools.className = "playlistSelectionTools";
  all.type = clear.type = "button";
  all.id = select.id + "SelectAll";
  clear.id = select.id + "ClearSelection";
  all.textContent = "Select all playlists";
  clear.textContent = "Clear selection";
  summary.setAttribute("role", "status");
  all.title = "Select every loaded playlist, including other search results and pages.";
  if (multiple) {
    tools.append(all, clear, summary);
    input.after(tools);
  }
  select.hidden = true;
  select.style.setProperty("display", "none", "important");
  select.after(root);
  let page = 0,
    lastSelection = "";
  function commit() {
    select.value = [...select.options].find((row) => selected.has(row.value))?.value || "";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    render();
  }
  function render() {
    root.hidden = select.options.length === 0;
    if (select.parentElement.tagName === "LABEL") select.parentElement.hidden = root.hidden;
    if (multiple) {
      const available = new Set([...select.options].map((row) => row.value));
      for (const id of selected) if (!available.has(id)) selected.delete(id);
      summary.textContent =
        selected.size + " of " + select.options.length + " loaded playlists selected";
      all.disabled = select.disabled || !select.options.length;
      clear.disabled = select.disabled || !selected.size;
    }
    const needle = input.value.trim().toLocaleLowerCase(),
      options = [...select.options].filter((row) =>
        row.textContent.toLocaleLowerCase().includes(needle),
      );
    if (!multiple && select.value !== lastSelection && !needle)
      page = Math.max(0, Math.floor(options.findIndex((row) => row.value === select.value) / 6));
    lastSelection = select.value;
    page = Math.max(0, Math.min(page, Math.ceil(options.length / 6) - 1));
    list.replaceChildren();
    for (const option of options.slice(page * 6, page * 6 + 6)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "playlistBrowserRow";
      button.textContent = option.textContent;
      button.setAttribute(
        "aria-pressed",
        String(multiple ? selected.has(option.value) : option.value === select.value),
      );
      button.disabled = option.disabled || select.disabled;
      button.onclick = () => {
        if (multiple) {
          selected.has(option.value) ? selected.delete(option.value) : selected.add(option.value);
          commit();
        } else {
          select.value = option.value;
          select.dispatchEvent(new Event("change", { bubbles: true }));
          render();
        }
      };
      list.append(button);
    }
    if (!options.length) {
      const empty = document.createElement("p");
      empty.textContent = select.options.length ? "No matching playlists." : "No playlists loaded.";
      list.append(empty);
    }
    count.textContent = options.length
      ? `${page * 6 + 1}-${Math.min(options.length, page * 6 + 6)} of ${options.length}`
      : "0 playlists";
    previous.disabled = page === 0;
    next.disabled = (page + 1) * 6 >= options.length;
    footer.hidden = options.length <= 6;
  }
  input.oninput = () => {
    page = 0;
    render();
  };
  previous.onclick = () => {
    page--;
    render();
  };
  next.onclick = () => {
    page++;
    render();
  };
  all.onclick = () => {
    for (const row of select.options) if (!row.disabled) selected.add(row.value);
    commit();
  };
  clear.onclick = () => {
    selected.clear();
    commit();
  };
  select.addEventListener("change", render);
  const observer = new MutationObserver(render);
  observer.observe(select, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
  });
  window.addEventListener("pagehide", () => observer.disconnect(), {
    once: true,
  });
  render();
  return {
    render,
    selected: () =>
      [...select.options]
        .filter((row) => (multiple ? selected.has(row.value) : row.value === select.value))
        .map((row) => ({ id: row.value, name: row.textContent })),
    select(ids) {
      selected.clear();
      ids.forEach((id) => selected.add(id));
      commit();
    },
  };
};
(() => {
  const style = document.createElement("style");
  style.textContent =
    "#libraryView{display:grid;grid-template-columns:260px minmax(0,1fr);gap:20px;align-items:start}#libraryView[hidden]{display:none}#libraryView .librarySidebar{position:sticky;top:12px;display:flex;align-items:stretch;flex-wrap:wrap;gap:8px;margin:0}#libraryView .librarySidebar>label{width:100%}#libraryView .librarySidebar>.spacer{display:none}#libraryView .librarySidebar>.status{width:100%}#libraryView .librarySidebar .playlistBrowserRows{grid-template-columns:1fr}.libraryDetails{min-width:0}@media(max-width:900px){#libraryView{grid-template-columns:1fr}#libraryView .librarySidebar{position:static}#libraryView .librarySidebar .playlistBrowserRows{grid-template-columns:repeat(2,minmax(0,1fr))}}.playlistBrowser{width:min(100%,640px);min-width:0;font-size:13px}.playlistBrowser>input{width:100%;min-width:0;margin-bottom:8px}.playlistBrowserRows{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}.playlistBrowserRow{height:auto!important;min-height:44px;text-align:left!important;white-space:normal;overflow-wrap:anywhere;padding:10px!important;line-height:1.4}.playlistBrowserRow[aria-pressed=true]{border-color:var(--accent);background:var(--surface,#101a2c)}.playlistBrowserFooter{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px}.playlistBrowserFooter[hidden]{display:none}.playlistBrowserFooter span{color:var(--muted)}label:has(>.playlistBrowser){width:min(100%,640px);min-width:0}section:has(>.playlistBrowser){min-width:0}@media(max-width:560px){.playlistBrowserRows{grid-template-columns:1fr}}";
  document.head.append(style);
})();
