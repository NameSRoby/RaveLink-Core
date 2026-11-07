import { createWindowsPanel } from "./control-deck-windows-panel.js";
import { sliderControl, sliderIncrement } from "./control-deck-slider.js";
/** Audio rendering and completion receipts share the existing deck feed. */
export function createDeckAudioUi({
  host,
  workspace,
  rack,
  request,
  add,
  explain,
  isVisible,
  getSnapshot,
  getCatalog,
  getPageId,
  save,
  note,
}) {
  const completions = new Map();
  const mixer = createWindowsPanel({
    request,
    add,
    explain,
    inline: true,
    visible: isVisible,
    getSliderIncrement: () => sliderIncrement(getSnapshot()?.config.layout),
    getMusicProvider: () =>
      getCatalog().find((action) => action.id === "song.volume")?.nativeProvider ||
      getSnapshot()?.widgetData?.music?.current?.provider ||
      "",
    onHide: (target) => {
      const config = structuredClone(getSnapshot().config),
        page = config.pages.find((page) => page.id === getPageId());
      page.mixer.hiddenTargets = target ? [...new Set([...page.mixer.hiddenTargets, target])] : [];
      void save(config).catch((error) => note(explain(error), true));
    },
  });
  workspace.before(mixer.element);
  return {
    refresh: mixer.refresh,
    settle() {
      const snapshot = getSnapshot();
      for (const [id, waiter] of completions)
        if (!snapshot.running?.some((run) => run.runId === id)) {
          clearTimeout(waiter.timer);
          completions.delete(id);
          waiter.resolve(snapshot.states?.[waiter.buttonId]?.lastResult);
        }
    },
    async wait(id, buttonId) {
      const snapshot = getSnapshot();
      if (!snapshot.running?.some((run) => run.runId === id))
        return snapshot.states?.[buttonId]?.lastResult;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          completions.delete(id);
          reject(Error("slider_change_unconfirmed"));
        }, 15000);
        completions.set(id, { resolve, reject, timer, buttonId });
      });
    },
    render(config, page, editing, deck) {
      for (const input of host.querySelectorAll(".deckVolumeSlider")) sliderControl(input)?.close();
      for (const tile of mixer.element.querySelectorAll("[data-deck-button]")) tile.remove();
      mixer.setExtras([]);
      host.dataset.sliderOrientation = config.layout.sliderOrientation;
      host.dataset.sliderDock = config.layout.sliderDock;
      host.dataset.sliderPlacement = page.mixer?.enabled ? "inside" : config.layout.sliderPlacement;
      host.dataset.mixerPage = String(page.mixer?.enabled === true);
      if (deck && page.mixer?.enabled) {
        mixer.element.dataset.editing = String(editing);
        void mixer.open({ ...page.mixer, editing, orientation: config.layout.sliderOrientation });
      } else mixer.close();
      for (const slider of host.querySelectorAll(".deckVolumeSlider"))
        sliderControl(slider)?.close();
      rack.replaceChildren();
    },
    finish(page, editing) {
      if (page.mixer?.enabled)
        mixer.setExtras(
          [...workspace.querySelectorAll("[data-deck-button]:has(.deckVolumeSlider)")].map(
            (tile) => (editing ? tile.closest(".deckTile") || tile : tile),
          ),
        );
      if (host.dataset.sliderPlacement === "dock")
        for (const tile of workspace.querySelectorAll(
          ".deckGrid [data-deck-button]:has(.deckVolumeSlider)",
        ))
          rack.append(tile.closest(".deckTile") || tile);
      rack.hidden = !rack.childElementCount;
    },
    close() {
      mixer.close();
      for (const slider of host.querySelectorAll(".deckVolumeSlider"))
        sliderControl(slider)?.close();
      for (const waiter of completions.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(Error("control_deck_closed"));
      }
      completions.clear();
    },
  };
}
