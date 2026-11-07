import "./browser-random-id.js";
/** Layout entries use the same LAN-compatible UUID source as other browser controls. */
export function deckId() {
  return "deck-" + globalThis.RaveLinkRandomId();
}
