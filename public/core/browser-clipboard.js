/** HTTP LAN pages lack the secure Clipboard API. Preserve copy actions through
 * the browser's user-gesture clipboard command; no network/native bridge.
 */
(() => {
  if (navigator.clipboard?.writeText) return;
  const writeText = async (value) => {
    const active = document.activeElement;
    const field = document.createElement("textarea");
    field.value = String(value);
    field.style.position = "fixed";
    field.style.left = "-9999px";
    document.body.append(field);
    field.select();
    try {
      if (!document.execCommand("copy"))
        throw Error("Copy was blocked by this browser. Select the text and copy it manually.");
    } finally {
      field.remove();
      active?.focus();
    }
  };
  try {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  } catch {}
})();
