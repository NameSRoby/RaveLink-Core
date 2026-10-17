/**
 * Workspace navigation.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#request-security-and-the-feature-ui-relay
 */
(() => {
  const menu = document.getElementById("moreNav");
  if (!menu) return;
  function sync() {
    const selected = Boolean(menu.querySelector("[data-tab].active"));
    menu.classList.toggle("active", selected);
    menu.querySelector("summary")?.setAttribute("aria-current", selected ? "page" : "false");
  }
  document.addEventListener("click", (event) => {
    if (event.target.closest("#moreNav [data-tab]")) menu.open = false;
    if (event.target.closest("[data-tab]")) sync();
    else if (!event.target.closest("#moreNav")) menu.open = false;
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && menu.open) {
      menu.open = false;
      menu.querySelector("summary")?.focus();
    }
  });
  sync();
})();
