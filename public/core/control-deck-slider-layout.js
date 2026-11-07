import { deckId } from "./control-deck-id.js";
/** Moving a saved slider preserves its ID, actions and appearance. */
export function placeDeckSliders(config) {
  if (config.layout?.sliderPlacement !== "page") return config;
  const copy = structuredClone(config);
  let mixer = copy.pages.find((page) => page.mixer?.enabled);
  if (!mixer) {
    mixer = {
      id: deckId(),
      name: "Audio mixer",
      mixer: { enabled: true, hiddenTargets: [] },
      buttons: [],
    };
    copy.pages.splice(Math.min(1, copy.pages.length), 0, mixer);
  }
  for (const page of copy.pages)
    if (page !== mixer) {
      mixer.buttons.push(...page.buttons.filter((button) => button.kind === "slider"));
      page.buttons = page.buttons.filter((button) => button.kind !== "slider");
    }
  return copy;
}
