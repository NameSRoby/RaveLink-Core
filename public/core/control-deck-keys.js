/** Browser-focused shortcuts; never installs Windows-wide keyboard hooks. */
export function deckKey(event) {
  if (event.isComposing || /^(?:Control|Shift|Alt|Meta)(?:Left|Right)$/.test(event.code || ""))
    return "";
  return [
    event.ctrlKey && "Ctrl",
    event.altKey && "Alt",
    event.shiftKey && "Shift",
    event.metaKey && "Meta",
    event.code,
  ]
    .filter(Boolean)
    .join("+");
}
export function keyControl({ value = "", label = "Keyboard trigger" } = {}) {
  const field = document.createElement("label");
  field.className = "deckField";
  const title = document.createElement("span"),
    input = document.createElement("input"),
    clear = document.createElement("button");
  title.textContent = label;
  input.type = "text";
  input.readOnly = true;
  input.value = value;
  input.placeholder = "Click, then press a key";
  input.setAttribute("aria-label", label);
  input.onkeydown = (event) => {
    if (event.key === "Tab") return;
    if (event.key === "Escape") {
      input.blur();
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const key = deckKey(event);
    if (key) {
      input.value = key;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  };
  clear.type = "button";
  clear.textContent = "Clear";
  clear.setAttribute("aria-label", "Clear " + label);
  clear.onclick = () => {
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const row = document.createElement("div");
  row.className = "deckKeyControl";
  row.append(input, clear);
  field.append(title, row);
  return { field, input };
}
export function installDeckKeys({ host, getConfig, isEditing, pager }) {
  document.addEventListener("keydown", (event) => {
    if (
      event.defaultPrevented ||
      event.repeat ||
      event.isComposing ||
      document.hidden ||
      host.hidden ||
      isEditing() ||
      !host.getClientRects().length ||
      document.querySelector("dialog[open]") ||
      event.target.closest?.('input,textarea,select,[contenteditable="true"]')
    )
      return;
    const config = getConfig();
    if (!config) return;
    const key = deckKey(event),
      layout = config.layout || {};
    if (
      host.dataset.focus === "true" &&
      host.dataset.paged === "true" &&
      layout.fullscreenKeyboard &&
      [layout.previousKey, layout.nextKey].includes(key)
    ) {
      event.preventDefault();
      pager.move(key === layout.previousKey ? -1 : 1);
      return;
    }
    if (!layout.keyboardButtons) return;
    const button = config.pages
      .flatMap((page) => page.buttons)
      .find(
        (button) =>
          button.activationKey === key &&
          host.querySelector(`[data-deck-button="${CSS.escape(button.id)}"]`),
      );
    if (!button) return;
    const tile = host.querySelector(`[data-deck-button="${CSS.escape(button.id)}"]`);
    if (tile.disabled) return;
    event.preventDefault();
    pager.reveal(tile);
    if (button.kind === "slider") tile.querySelector("input")?.focus();
    else tile.click();
  });
}
