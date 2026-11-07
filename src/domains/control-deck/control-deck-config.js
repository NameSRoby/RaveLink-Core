/** Operator-authored macro data. No code, paths to executable scripts, credentials
 * or external media are interpreted by this persistence layer. */
const fault = (code) => Object.assign(Error(code), { code });
const record = (v) => v && typeof v === "object" && !Array.isArray(v);
const id = (v) => typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,191}$/.test(v);
function json(value, depth = 0) {
  if (depth > 8) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= 4096;
  if (Array.isArray(value)) return value.length <= 64 && value.every((v) => json(v, depth + 1));
  return (
    record(value) &&
    Object.keys(value).length <= 64 &&
    Object.entries(value).every(
      ([k, v]) =>
        k.length <= 80 &&
        !["__proto__", "prototype", "constructor"].includes(k) &&
        json(v, depth + 1),
    )
  );
}
function closed(value, keys) {
  return record(value) && Object.keys(value).every((k) => keys.includes(k));
}
const color = (v) => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
const keyBinding = (value) =>
  typeof value === "string" &&
  value.length <= 80 &&
  /^(?:(?:Ctrl|Alt|Shift|Meta)\+)*(?:Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Arrow(?:Left|Right|Up|Down)|Numpad[A-Za-z0-9]+|Space|Enter|Escape|Tab|Home|End|PageUp|PageDown|Insert|Delete|Backspace|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash)$/.test(
    value,
  );
function steps(value = []) {
  if (!Array.isArray(value) || value.length > 16) throw fault("control_deck_steps_invalid");
  let duration = 0;
  return value.map((step) => {
    const delayMs = step.delayMs ?? 0,
      params = step.params ?? {};
    if (
      !closed(step, ["actionId", "params", "delayMs"]) ||
      !id(step.actionId) ||
      !json(params) ||
      JSON.stringify(params).length > 16384 ||
      !Number.isInteger(delayMs) ||
      delayMs < 0 ||
      delayMs > 10000 ||
      (duration += delayMs) > 30000
    )
      throw fault("control_deck_steps_invalid");
    return { actionId: step.actionId, params: structuredClone(params), delayMs };
  });
}
function appearance(value = {}) {
  if (
    !closed(value, [
      "symbol",
      "textMode",
      "imageId",
      "color",
      "cycleColors",
      "textColor",
      "cycleMs",
      "backlight",
      "profileBacklight",
      "sliderOrientation",
      "sliderStyle",
      "sliderSnap",
      "sliderIncrement",
    ])
  )
    throw fault("control_deck_appearance_invalid");
  const result = {
    symbol: "✦",
    textMode: "auto",
    imageId: "",
    color: "#a90036",
    cycleColors: [],
    textColor: "#ffffff",
    cycleMs: 6000,
    backlight: 65,
    profileBacklight: "auto",
    sliderOrientation: "inherit",
    sliderStyle: "inherit",
    sliderSnap: "inherit",
    sliderIncrement: 5,
    ...value,
  };
  if (
    typeof result.symbol !== "string" ||
    result.symbol.length > 64 ||
    !["auto", "image", "image-text", "text", "alternate"].includes(result.textMode) ||
    (result.imageId !== "" && !/^[a-f0-9]{64}\.(png|jpg|gif)$/.test(result.imageId)) ||
    !color(result.color) ||
    !color(result.textColor) ||
    !Array.isArray(result.cycleColors) ||
    result.cycleColors.length > 8 ||
    !result.cycleColors.every(color) ||
    !Number.isInteger(result.cycleMs) ||
    result.cycleMs < 500 ||
    result.cycleMs > 30000 ||
    !Number.isInteger(result.backlight) ||
    result.backlight < 0 ||
    result.backlight > 100 ||
    !["auto", "custom"].includes(result.profileBacklight) ||
    !["inherit", "vertical", "horizontal"].includes(result.sliderOrientation) ||
    !["inherit", "button", "mixer"].includes(result.sliderStyle) ||
    !["inherit", "on", "off"].includes(result.sliderSnap) ||
    !Number.isInteger(result.sliderIncrement) ||
    result.sliderIncrement < 1 ||
    result.sliderIncrement > 100
  )
    throw fault("control_deck_appearance_invalid");
  return result;
}
function toggleStates(value) {
  if (!closed(value, ["off", "on"])) throw fault("control_deck_toggle_invalid");
  const result = {};
  for (const key of ["off", "on"]) {
    const state = value[key];
    if (
      !closed(state, ["label", "symbol", "color"]) ||
      typeof state.label !== "string" ||
      !state.label.trim() ||
      state.label.length > 80 ||
      typeof state.symbol !== "string" ||
      state.symbol.length > 64 ||
      !color(state.color)
    )
      throw fault("control_deck_toggle_invalid");
    result[key] = { label: state.label.trim(), symbol: state.symbol, color: state.color };
  }
  return result;
}
function layout(value = {}) {
  if (
    !closed(value, [
      "phoneColumns",
      "tabletColumns",
      "gap",
      "radius",
      "labelScale",
      "showStatus",
      "shape",
      "backlight",
      "display",
      "fullscreenMode",
      "fullscreenSwipe",
      "fullscreenKeyboard",
      "previousKey",
      "nextKey",
      "keyboardButtons",
      "sliderOrientation",
      "sliderStyle",
      "sliderPlacement",
      "sliderSnap",
      "sliderIncrement",
      "sliderDock",
      "screen",
    ])
  )
    throw fault("control_deck_layout_invalid");
  const result = {
    phoneColumns: 2,
    tabletColumns: 4,
    gap: 14,
    radius: 28,
    labelScale: 100,
    showStatus: true,
    shape: "square",
    backlight: 100,
    display: "auto",
    fullscreenMode: "scroll",
    fullscreenSwipe: false,
    fullscreenKeyboard: false,
    previousKey: "ArrowLeft",
    nextKey: "ArrowRight",
    keyboardButtons: false,
    sliderOrientation: "vertical",
    sliderStyle: "mixer",
    sliderPlacement: "dock",
    sliderDock: "end",
    sliderSnap: false,
    sliderIncrement: 5,
    ...value,
  };
  const ranges = {
    phoneColumns: [1, 12],
    tabletColumns: [1, 12],
    gap: [0, 32],
    radius: [0, 32],
    labelScale: [70, 150],
    backlight: [0, 100],
    sliderIncrement: [1, 100],
  };
  if (result.screen !== undefined) {
    const screen = result.screen;
    if (
      !closed(screen, ["mediaId", "brightness", "fit"]) ||
      typeof screen.mediaId !== "string" ||
      (screen.mediaId !== "" && !/^[a-f0-9]{64}\.(png|jpg|gif|mp4|webm)$/.test(screen.mediaId)) ||
      !Number.isInteger(screen.brightness) ||
      screen.brightness < 10 ||
      screen.brightness > 100 ||
      !["cover", "contain"].includes(screen.fit)
    )
      throw fault("control_deck_screen_invalid");
  }
  if (
    Object.entries(ranges).some(
      ([key, [min, max]]) =>
        !Number.isInteger(result[key]) || result[key] < min || result[key] > max,
    ) ||
    typeof result.showStatus !== "boolean" ||
    typeof result.sliderSnap !== "boolean" ||
    !["vertical", "horizontal"].includes(result.sliderOrientation) ||
    !["button", "mixer"].includes(result.sliderStyle) ||
    !["inside", "dock", "page"].includes(result.sliderPlacement) ||
    !["start", "end"].includes(result.sliderDock) ||
    !["scroll", "pages"].includes(result.fullscreenMode) ||
    ["fullscreenSwipe", "fullscreenKeyboard", "keyboardButtons"].some(
      (key) => typeof result[key] !== "boolean",
    ) ||
    !keyBinding(result.previousKey) ||
    !keyBinding(result.nextKey) ||
    result.previousKey === result.nextKey ||
    !["square", "wide", "tall"].includes(result.shape) ||
    !["auto", "per-button", "image-text", "image", "text", "alternate"].includes(result.display)
  )
    throw fault("control_deck_layout_invalid");
  return result;
}
function validate(value) {
  if (
    !closed(value, ["version", "mode", "columns", "pages", "layout", "widgets"]) ||
    value.version !== 1 ||
    !["overview", "deck"].includes(value.mode) ||
    !Number.isInteger(value.columns) ||
    value.columns < 1 ||
    value.columns > 12 ||
    !Array.isArray(value.pages) ||
    !value.pages.length ||
    value.pages.length > 12 ||
    JSON.stringify(value).length > 262144
  )
    throw fault("control_deck_config_invalid");
  const pages = new Set(),
    buttons = new Set();
  const normalized = value.pages.map((page) => {
    if (
      !closed(page, ["id", "name", "buttons", "mixer"]) ||
      !id(page.id) ||
      pages.has(page.id) ||
      typeof page.name !== "string" ||
      !page.name.trim() ||
      page.name.length > 60 ||
      !Array.isArray(page.buttons) ||
      page.buttons.length > 64
    )
      throw fault("control_deck_page_invalid");
    pages.add(page.id);
    const mixer = page.mixer;
    if (
      mixer !== undefined &&
      (!closed(mixer, ["enabled", "hiddenTargets"]) ||
        typeof mixer.enabled !== "boolean" ||
        !Array.isArray(mixer.hiddenTargets) ||
        mixer.hiddenTargets.length > 128 ||
        mixer.hiddenTargets.some(
          (target) =>
            typeof target !== "string" ||
            !/^(?:system|microphone|(?:device|app):[a-f0-9]{64})$/.test(target),
        ))
    )
      throw fault("control_deck_mixer_invalid");
    return {
      id: page.id,
      name: page.name.trim(),
      ...(mixer === undefined
        ? {}
        : { mixer: { enabled: mixer.enabled, hiddenTargets: [...new Set(mixer.hiddenTargets)] } }),
      buttons: page.buttons.map((button) => {
        if (
          !closed(button, [
            "id",
            "title",
            "kind",
            "pageId",
            "steps",
            "alternateSteps",
            "holdSteps",
            "toggleStates",
            "activationKey",
            "placement",
            "appearance",
          ]) ||
          !id(button.id) ||
          buttons.has(button.id) ||
          buttons.size >= 256 ||
          typeof button.title !== "string" ||
          button.title.length > 80 ||
          !["macro", "folder", "slider"].includes(button.kind)
        )
          throw fault("control_deck_button_invalid");
        buttons.add(button.id);
        const result = {
          id: button.id,
          title: button.title,
          kind: button.kind,
          pageId: button.pageId || "",
          steps: steps(button.steps),
          alternateSteps: steps(button.alternateSteps),
          holdSteps: steps(button.holdSteps),
          appearance: appearance(button.appearance),
        };
        if (button.toggleStates !== undefined) {
          if (result.kind !== "macro" || !result.alternateSteps.length)
            throw fault("control_deck_toggle_invalid");
          result.toggleStates = toggleStates(button.toggleStates);
        }
        if (button.activationKey !== undefined) {
          if (button.activationKey !== "" && !keyBinding(button.activationKey))
            throw fault("control_deck_key_invalid");
          result.activationKey = button.activationKey;
        }
        if (button.placement !== undefined) {
          if (!["flow", "new-row", "own-row"].includes(button.placement))
            throw fault("control_deck_placement_invalid");
          // Read earlier local drafts, then let the automatic layout place them.
        }
        if (
          (result.kind === "folder" &&
            (!id(result.pageId) ||
              result.steps.length ||
              result.alternateSteps.length ||
              result.holdSteps.length)) ||
          (result.kind !== "folder" && (!result.steps.length || result.pageId)) ||
          (result.kind === "slider" &&
            (result.steps.length !== 1 || result.alternateSteps.length || result.holdSteps.length))
        )
          throw fault("control_deck_button_invalid");
        return result;
      }),
    };
  });
  for (const page of normalized) {
    const bindings = page.buttons.map((button) => button.activationKey).filter(Boolean);
    if (new Set(bindings).size !== bindings.length) throw fault("control_deck_key_conflict");
    const settings = layout(value.layout);
    if (
      settings.fullscreenKeyboard &&
      bindings.some((key) => [settings.previousKey, settings.nextKey].includes(key))
    )
      throw fault("control_deck_key_conflict");
  }
  if (normalized.some((p) => p.buttons.some((b) => b.kind === "folder" && !pages.has(b.pageId))))
    throw fault("control_deck_folder_invalid");
  return {
    version: 1,
    mode: value.mode,
    columns: value.columns,
    layout: layout(value.layout),
    widgets: require("./deck-widget-config")(value.widgets),
    pages: normalized,
  };
}
function defaults() {
  const button = (id, title, actionId, symbol, params = {}, kind = "macro") => ({
    id,
    title,
    kind,
    steps: [{ actionId, params, delayMs: 0 }],
    appearance: { symbol },
  });
  return validate({
    version: 1,
    mode: "overview",
    columns: 5,
    pages: [
      {
        id: "quick-access",
        name: "Quick Access",
        buttons: [
          button("playback-toggle", "Playback", "song.playback-toggle", "⏯"),
          button("song-volume", "Player volume", "song.volume", "◕", { level: 100 }, "slider"),
          button("song-skip", "Skip request", "song.skip", "⏭"),
          button("player-previous", "Previous song", "native.player.previous", "\u23ee"),
          button("player-next", "Next song", "native.player.next", "\u23ed"),
          button("intake-toggle", "Song requests", "song.intake-toggle", "⏯"),
          button("ban-song", "Ban current song", "song.ban-current", "⊘"),
          button("ban-requester", "Ban requester", "song.ban-requester", "⊗"),
          button("discord-mic", "Discord microphone", "native.hotkey", "🎙", { shortcut: "F13" }),
          button("discord-deafen", "Discord deafen", "native.hotkey", "🎧", { shortcut: "F14" }),
          button("twitch-clip", "Clip broadcast", "mod:ravelink.twitch-clips:create", "✂", {
            duration: 30,
          }),
          button("music-toggle", "Music lights", "music.toggle", "\u23ef"),
          button("auto-rave", "Auto-Rave", "music.auto-toggle", "\u21bb"),
          button("rave", "Rave / restore", "music.rave-toggle", "\u03df"),
          button("rewards-toggle", "Channel Points rewards", "rewards.toggle", "⏯"),
          button("windows-controls", "Windows controls", "view.windows", "\u229e"),
        ],
      },
      require("./audio-mixer-page").audioPage(),
    ],
  });
}
module.exports = { validate, defaults, json, closed, fault };
