import { createDeckAwake } from "./control-deck-awake.js";
/** A user gesture enters native fullscreen; unsupported clients retain a grid view. */
export function createDeckFullscreen({ host, button, onEnter }) {
  let active = false,
    native = false,
    generation = 0;
  const chrome = document.createElement("div");
  chrome.className = "deckFullscreenBar";
  chrome.hidden = true;
  host.prepend(chrome);
  const exit = document.createElement("button");
  exit.id = "deckExitFullscreen";
  exit.className = "deckExitFullscreen";
  exit.type = "button";
  exit.hidden = true;
  exit.setAttribute("aria-label", "Exit button fullscreen");
  exit.title = "Exit fullscreen (Escape)";
  exit.textContent = "⤢";
  host.append(exit);
  const awakeButton = document.createElement("label");
  awakeButton.id = "deckKeepAwake";
  awakeButton.className = "deckKeepAwake";
  const awakeSwitch = document.createElement("input"),
    awakeText = document.createElement("span"),
    awakeDot = document.createElement("span");
  awakeSwitch.type = "checkbox";
  awakeSwitch.checked = true;
  awakeSwitch.setAttribute("role", "switch");
  awakeSwitch.setAttribute("aria-label", "Keep screen awake");
  awakeText.textContent = "Keep screen awake";
  awakeDot.className = "deckAwakeStatus";
  awakeDot.setAttribute("aria-hidden", "true");
  awakeButton.append(awakeSwitch, awakeText, awakeDot);
  awakeButton.dataset.state = "idle";
  const home = host.querySelector(".deckTools") || button.parentElement || host;
  awakeButton.title =
    "On by default. Keeps the screen awake only while the fullscreen deck is visible.";
  const awake = createDeckAwake({
    onState(state) {
      awakeButton.dataset.state = state;
      awakeButton.title =
        state === "fallback"
          ? "Silent local playback requests an awake screen on HTTP LAN browsers; device support varies. Tap to disable."
          : state === "blocked"
            ? "Your browser or power settings interrupted screen protection. Turn the toggle off and on to retry."
            : "Keep this device's screen awake in fullscreen. Tap to toggle.";
    },
  });
  awakeSwitch.onchange = () => {
    awakeButton.dataset.state = awakeSwitch.checked ? (active ? "requesting" : "idle") : "off";
    if (awakeSwitch.checked !== awake.enabled) awake.toggle();
  };
  home.append(awakeButton);
  function reset() {
    generation++;
    active = native = false;
    host.dataset.focus = "false";
    exit.hidden = true;
    chrome.hidden = true;
    home.append(awakeButton);
    awake.leave();
    button.setAttribute("aria-pressed", "false");
    button.focus({ preventScroll: true });
  }
  function leave() {
    reset();
    if (document.fullscreenElement === host) void document.exitFullscreen().catch(() => {});
  }
  button.textContent = "Fullscreen";
  button.title = "Show your buttons and status widgets; Escape exits";
  button.onclick = () => {
    if (active) return leave();
    const ticket = ++generation;
    active = true;
    chrome.append(awakeButton, exit);
    chrome.hidden = false;
    awake.enter();
    onEnter();
    host.dataset.focus = "true";
    exit.hidden = false;
    button.setAttribute("aria-pressed", "true");
    if (host.requestFullscreen)
      void host
        .requestFullscreen({ navigationUI: "hide" })
        .then(() => {
          if (active && ticket === generation) native = true;
          else if (document.fullscreenElement === host)
            void document.exitFullscreen().catch(() => {});
        })
        .catch(() => {});
    host.querySelector("[data-deck-button]:not(:disabled)")?.focus();
  };
  exit.onclick = leave;
  document.addEventListener("fullscreenchange", () => {
    if (document.fullscreenElement === host) native = true;
    else if (active && native) reset();
  });
  document.addEventListener("keydown", (event) => {
    if (active && event.key === "Escape") leave();
  });
  return {
    leave: () => {
      if (active) leave();
    },
  };
}
