import { bindDeckSlider, sliderControl } from "./control-deck-slider.js";
/** Live Windows audio. Opening and pinning controls never changes audio. */
export function createWindowsPanel({
  request,
  add,
  explain,
  inline = false,
  onHide = () => {},
  visible = () => true,
  getMusicProvider = () => "",
  getSliderIncrement = () => 1,
}) {
  const el = (tag, text, css) => {
    const e = document.createElement(tag);
    if (text !== undefined) e.textContent = text;
    if (css) e.className = css;
    return e;
  };
  const dialog = el(
      inline ? "section" : "dialog",
      undefined,
      inline ? "deckWindowsPanel deckInlineMixer" : "deckEditor deckWindowsPanel",
    ),
    heading = el("div", undefined, "deckEditorHeading"),
    title = el("h2", inline ? "Audio mixer" : "Windows controls"),
    notice = el("p", "", "deckEditorNotice");
  dialog.id = inline ? "deckAudioMixer" : "deckWindowsPanel";
  title.id = inline ? "deckAudioMixerTitle" : "deckWindowsTitle";
  if (inline) {
    dialog.hidden = true;
    dialog.open = false;
    dialog.close = () => {
      dialog.open = false;
      dialog.hidden = true;
      revision++;
      clearTimeout(timer);
    };
  }
  dialog.setAttribute("aria-labelledby", title.id);
  notice.setAttribute("role", "status");
  const cards = new Map();
  const channels = el("div", undefined, "deckMixerChannels");
  let extras = [],
    nativeOrder = [],
    lastLayout = [];
  let selected = "",
    hiddenTargets = new Set(),
    editing = false,
    timer,
    reading = null,
    saving = 0,
    revision = 0;
  const button = (text, fn) => {
    const e = el("button", text);
    e.type = "button";
    e.onclick = () => void fn();
    return e;
  };
  heading.append(title);
  if (!inline) heading.append(button("Close", () => dialog.close()));
  const tools = el("div", undefined, "deckPanelActions"),
    all = button("All audio", () => {
      selected = "";
      title.textContent = "Windows controls";
      notice.textContent = "";
      void read();
    });
  tools.append(
    button("Refresh", () => read()),
    all,
  );
  if (!inline)
    tools.append(
      button("Microphone", () => {
        selected = "microphone";
        notice.textContent = "";
        void read();
      }),
    );
  const appsSection = el("div", undefined, "deckMixerTools"),
    search = el("input"),
    empty = el(
      "p",
      "Apps appear when Windows creates an audio session. Play audio in an app to find it here.",
      "deckEditorHint",
    );
  search.type = "search";
  search.placeholder = "Find an app";
  search.setAttribute("aria-label", "Find app audio");
  appsSection.append(search, empty);
  const media = el("section"),
    mediaButtons = el("div", undefined, "deckPanelActions");
  media.append(el("h3", "Media controls"), mediaButtons);
  dialog.append(
    heading,
    el("p", "Windows audio · controls the PC hosting RaveLink.", "deckEditorHint"),
    tools,
    notice,
    appsSection,
    channels,
    media,
  );
  document.body.append(dialog);
  const restore = button("+ Channel", () => {
    hiddenTargets.clear();
    onHide(null);
    void read();
  });
  restore.hidden = true;
  if (inline) tools.append(restore);
  if (inline) {
    media.hidden = true;
  }
  async function pin(name, id, params, symbol, kind = "macro") {
    try {
      await add(name, id, params, symbol, kind);
      notice.textContent = "Added to your deck. Use Edit to customize it.";
    } catch (error) {
      notice.textContent = explain(error);
    }
  }
  for (const [key, name, symbol] of [
    ["previous", "Previous", "\u23ee"],
    ["playPause", "Play / pause", "\u23ef"],
    ["next", "Next", "\u23ed"],
    ["stop", "Stop", "\u23f9"],
  ]) {
    const group = el("span", undefined, "deckWindowsMediaItem"),
      control = button(symbol + " " + name, async () => {
        control.disabled = true;
        try {
          await request("/api/control-deck/windows/media", "POST", { key });
          notice.textContent = "Media command sent to Windows.";
        } catch (error) {
          notice.textContent = explain(error);
        } finally {
          control.disabled = false;
        }
      });
    const save = button("+", () => pin("Media " + name, "native.media", { key }, symbol));
    save.setAttribute("aria-label", "Pin media " + name);
    group.append(control, save);
    mediaButtons.append(group);
  }
  function make(target, name, parent) {
    const element = el("section", undefined, "deckWindowsAudioCard"),
      head = el("div", undefined, "deckWindowsAudioHeading"),
      copy = el("div"),
      label = el("strong", name),
      detail = el("small"),
      pins = el("details", undefined, "deckWindowsPins"),
      summary = el("summary", "+");
    element.append(
      el("span", undefined, "deckLedSource"),
      el("span", undefined, "deckAcrylicFace"),
    );
    summary.setAttribute("aria-label", "Pin " + name);
    pins.append(summary);
    pins.addEventListener("click", (event) => {
      if (event.target.closest("button")) pins.open = false;
    });
    pins.addEventListener("toggle", () => {
      if (pins.open)
        for (const other of dialog.querySelectorAll(".deckWindowsPins"))
          if (other !== pins) other.open = false;
    });
    const slider = el("input"),
      value = el("output"),
      mute = button("Mute", () => change(card, { action: "toggle-mute" }));
    slider.type = "range";
    slider.min = 0;
    slider.max = 100;
    slider.step = 1;
    slider.dataset.increment = getSliderIncrement();
    slider.setAttribute("aria-label", name + " volume");
    const card = {
      target,
      name,
      element,
      label,
      detail,
      slider,
      value,
      mute,
      pending: false,
      editing: false,
    };
    if (inline) {
      const hide = button("×", () => {
        hiddenTargets.add(target);
        onHide(target);
        filter();
      });
      hide.className = "deckMixerHide";
      hide.setAttribute("aria-label", "Remove " + name + " channel");
      element.append(hide);
      card.hide = hide;
    }
    pins.append(
      button("Pin volume slider", () =>
        pin(
          name + " volume",
          "native.audio.volume:" + target,
          { level: Number(slider.value) },
          "\u25d5",
          "slider",
        ),
      ),
      button("Pin mute toggle", () =>
        pin(name + " mute", "native.audio.mute:" + target, {}, "\uD83D\uDD0A"),
      ),
      button("Pin audio popup", () =>
        pin(name + " controls", "native.audio.controls:" + target, {}, "\u25d5"),
      ),
    );
    bindDeckSlider({
      input: slider,
      output: value,
      send: (level) => change(card, { action: "volume", level }),
      onError: (error) => {
        notice.textContent = explain(error);
      },
    });
    copy.append(label, detail);
    head.append(copy, pins);
    const controls = el("div", undefined, "deckWindowsAudioValues");
    const track = el("div", undefined, "deckFaderTrack");
    track.append(slider);
    controls.append(track, value, mute);
    element.append(head, controls);
    parent.append(element);
    cards.set(target, card);
    return card;
  }
  function update(target, name, row, parent) {
    const card = cards.get(target) || make(target, name, parent);
    card.slider.dataset.increment = getSliderIncrement();
    if (card.element.parentNode !== parent) parent.append(card.element);
    card.name = name;
    card.isApp = row.kind === "app";
    if (card.label.textContent !== name) card.label.textContent = name;
    card.label.title = name;
    const detail =
      target === "system" || target === "microphone"
        ? row.name
        : row.kind === "app"
          ? row.sessions +
            " audio session" +
            (row.sessions === 1 ? "" : "s") +
            (row.mixed ? " · Mixed levels" : "")
          : row.kind === "input"
            ? "Input device"
            : "Output device";
    if (card.detail.textContent !== detail) card.detail.textContent = detail;
    sliderControl(card.slider).sync(row.volume);
    if (row.volume === null && !card.pending) card.value.textContent = "Mixed";
    const muteLabel = row.muted === true ? "Unmute" : "Mute";
    if (card.mute.textContent !== muteLabel) card.mute.textContent = muteLabel;
    card.mute.setAttribute("aria-label", card.mute.textContent + " " + name);
    card.mute.setAttribute("aria-pressed", String(row.muted === true));
    card.element.dataset.muted = String(row.muted === true);
    card.element.style.setProperty(
      "--deck-color",
      row.muted === true ? "#edb449" : row.volume === 0 ? "#8190a8" : "#27c58a",
    );
    card.slider.disabled = inline && editing;
    card.mute.disabled = card.pending || (inline && editing);
    if (card.hide) card.hide.hidden = !editing;
  }
  function filter() {
    for (const card of cards.values()) {
      const filtered =
        hiddenTargets.has(card.target) ||
        (card.isApp && !card.name.toLowerCase().includes(search.value.toLowerCase()));
      card.element.dataset.filtered = String(filtered);
      card.element.hidden = filtered || card.element.dataset.screenHidden === "true";
    }
    const next = [...channels.children].filter((element) => element.dataset.filtered !== "true");
    if (
      next.length !== lastLayout.length ||
      next.some((element, index) => element !== lastLayout[index])
    ) {
      lastLayout = next;
      dialog.dispatchEvent(new CustomEvent("ravelink-deck-mixer-layout", { bubbles: true }));
    }
  }
  function arrange() {
    const ordered = nativeOrder.map((key) => cards.get(key)?.element).filter(Boolean),
      provider = getMusicProvider();
    const match =
      provider &&
      nativeOrder.find((key) => {
        const name = cards.get(key)?.name.toLowerCase() || "";
        return ["youtube", "soundcloud"].includes(provider)
          ? /ravelink|webview/.test(name)
          : provider === "apple-music"
            ? /apple.?music|amplibraryagent/.test(name)
            : name.includes(provider);
      });
    const anchor = match ? ordered.indexOf(cards.get(match).element) : 0;
    ordered.splice(Math.max(0, anchor + 1), 0, ...extras);
    for (let index = 0; index < ordered.length; index++)
      if (channels.children[index] !== ordered[index])
        channels.insertBefore(ordered[index], channels.children[index] || null);
  }
  search.oninput = filter;
  function render(state) {
    if (!state.available) {
      notice.textContent = "Windows audio is unavailable. Check that an audio device is connected.";
      for (const card of cards.values()) card.slider.disabled = card.mute.disabled = true;
      return;
    }
    const wanted = new Set(),
      put = (key, name, row, parent) => {
        wanted.add(key);
        update(key, name, row, parent);
      };
    if (selected) {
      const row =
        selected === "system"
          ? state.output
          : selected === "microphone"
            ? state.input
            : [...state.devices, ...state.apps].find((r) => r.key === selected);
      if (row) {
        put(
          selected,
          selected === "system"
            ? "System audio"
            : selected === "microphone"
              ? "Windows microphone"
              : row.name,
          row,
          channels,
        );
        title.textContent = row.name + " audio";
      } else
        notice.textContent =
          "This audio target is unavailable. Play audio in the app or reconnect its device.";
    } else {
      if (state.output) put("system", "System audio", state.output, channels);
      for (const row of state.apps) put(row.key, row.name, row, channels);
      empty.hidden = state.apps.length > 0;
    }
    for (const [key, card] of cards)
      if (!wanted.has(key)) {
        card.element.remove();
        sliderControl(card.slider).close();
        cards.delete(key);
      }
    appsSection.hidden = !!selected;
    nativeOrder = [...wanted];
    arrange();
    all.hidden = !selected;
    filter();
  }
  async function change(card, command) {
    if (card.pending) return;
    card.pending = true;
    saving++;
    clearTimeout(timer);
    card.mute.disabled = true;
    try {
      const state = await request("/api/control-deck/windows/audio", "POST", {
        target: card.target,
        ...command,
      });
      card.pending = false;
      notice.textContent = "Windows audio updated.";
      if (dialog.open) render(state);
    } catch (error) {
      notice.textContent = explain(error);
      return false;
    } finally {
      card.pending = false;
      saving--;
      if (dialog.open) timer = setTimeout(() => void read(), 2000);
    }
  }
  async function read() {
    clearTimeout(timer);
    if (reading) return reading;
    if (saving || !dialog.open || !visible() || document.hidden) return;
    const current = revision;
    reading = Promise.resolve().then(async () => {
      try {
        const state = await request("/api/control-deck/windows/audio");
        if (dialog.open && revision === current) render(state);
      } catch (error) {
        if (dialog.open && revision === current) notice.textContent = explain(error);
      } finally {
        reading = null;
        if (dialog.open) timer = setTimeout(() => void read(), 2000);
      }
    });
    return reading;
  }
  document.addEventListener("ravelink-deck-state", (event) => {
    if (!dialog.open || saving || !event.detail) return;
    render(event.detail);
    clearTimeout(timer);
    timer = setTimeout(() => void read(), 2000);
  });
  dialog.addEventListener("close", () => {
    if (dialog.open) return; // A queued close event can belong to the previous view.
    revision++;
    clearTimeout(timer);
    for (const card of cards.values()) sliderControl(card.slider).cancel();
  });
  return {
    element: dialog,
    setExtras(nodes) {
      for (const node of extras) if (!nodes.includes(node)) node.remove();
      extras = nodes;
      arrange();
      filter();
    },
    channels,
    close: () => {
      dialog.close();
      for (const card of cards.values()) sliderControl(card.slider).cancel();
    },
    refresh: read,
    async open(options = {}) {
      const previousRead = reading,
        current = ++revision;
      const nextTarget = options.target || "";
      if (!dialog.open || selected !== nextTarget) {
        for (const card of cards.values()) {
          card.element.remove();
          sliderControl(card.slider).close();
        }
        cards.clear();
        nativeOrder = [];
      }
      selected = nextTarget;
      hiddenTargets = new Set(options.hiddenTargets || []);
      editing = options.editing === true;
      restore.hidden = !inline || !editing || !hiddenTargets.size;
      dialog.dataset.orientation = options.orientation || "vertical";
      search.value = "";
      notice.textContent = "";
      title.textContent = inline ? "Audio mixer" : "Windows controls";
      if (!dialog.open) {
        if (inline) {
          dialog.open = true;
          dialog.hidden = false;
        } else dialog.showModal();
      }
      if (previousRead) await previousRead;
      if (dialog.open && revision === current) await read();
    },
  };
}
