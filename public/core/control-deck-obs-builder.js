/** Source-first rules: when pressed -> this OBS object -> a valid action. */
export function createObsBuilder({ host, request, work, changed }) {
  const el = (tag, text, css) => {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (css) n.className = css;
    return n;
  };
  const field = (title, control) => {
    const label = el("label", undefined, "deckField");
    label.append(el("span", title), control);
    return label;
  };
  const select = (label) => {
    const n = el("select");
    n.setAttribute("aria-label", label);
    return n;
  };
  const options = (control, rows, placeholder) => {
    control.replaceChildren();
    if (placeholder) control.add(new Option(placeholder, ""));
    for (const [value, label] of rows) control.add(new Option(label, value));
  };
  let state,
    object,
    action,
    detail,
    help,
    generation = 0,
    current = null;
  function emit(target, label = "") {
    changed(target, label, current?.type === "scene" ? current.name : "");
  }
  const available = (method) => state.requests.includes(method);
  const sources = () => [
    ...state.inputs.map((r) => ({ type: "source", name: r.inputName })),
    ...state.scenes.map((r) => ({ type: "scene", name: r.sceneName })),
    ...(state.groups || []).map((name) => ({ type: "group", name })),
  ];
  async function chooseObject() {
    const epoch = ++generation;
    detail.replaceChildren();
    emit(null);
    current = null;
    if (!object.value) {
      options(action, [], "Choose an object first");
      return;
    }
    if (object.value === "obs") current = { type: "obs", name: "OBS Studio" };
    else current = sources().find((r) => r.type + ":" + r.name === object.value);
    if (!current) return;
    options(action, [], "Reading available actions…");
    help.textContent = "Reading this object’s available controls from OBS…";
    const selected = current,
      choices = [];
    let filters = [],
      audioAvailable = false;
    if (selected.type === "obs") {
      const rows = [
        ["studio-toggle", "Turn Studio Mode on / off", "SetStudioModeEnabled"],
        ["transition", "Transition Studio preview to program", "TriggerStudioModeTransition"],
        ["transition-choice", "Choose a transition", "SetCurrentSceneTransition"],
        ["record-toggle", "Start / stop recording", "ToggleRecord"],
        ["stream-toggle", "Start / stop streaming", "ToggleStream"],
        ["virtualcam-toggle", "Turn virtual camera on / off", "ToggleVirtualCam"],
        ["replay-save", "Save the replay buffer", "SaveReplayBuffer"],
      ];
      choices.push(...rows.filter((r) => available(r[2])).map((r) => r.slice(0, 2)));
      help.textContent =
        "Output controls affect the real broadcast or recording when the button is pressed.";
    } else {
      const tasks = [
        request(
          "/api/control-deck/obs/browse?kind=filters&name=" + encodeURIComponent(selected.name),
        ),
      ];
      if (selected.type === "source" && (available("SetInputMute") || available("SetInputVolume")))
        tasks.push(
          request(
            "/api/control-deck/obs/browse?kind=audio&name=" + encodeURIComponent(selected.name),
          ),
        );
      const reads = await Promise.allSettled(tasks);
      if (epoch !== generation) return;
      filters = reads[0].status === "fulfilled" ? reads[0].value.filters : [];
      audioAvailable = reads[1]?.status === "fulfilled";
      if (selected.type === "scene") {
        if (available("SetCurrentProgramScene")) choices.push(["scene", "Switch the live scene"]);
        if (state.studio && available("SetCurrentPreviewScene"))
          choices.push(["preview", "Select Studio preview (off air)"]);
      }
      if (available("SetSceneItemEnabled"))
        choices.push(
          ["source-toggle", "Show / hide source"],
          ["source-show", "Show source"],
          ["source-hide", "Hide source"],
        );
      if (audioAvailable && available("SetInputMute"))
        choices.push(
          ["mute-toggle", "Mute / unmute audio"],
          ["mute", "Mute audio"],
          ["unmute", "Unmute audio"],
        );
      if (audioAvailable && available("SetInputVolume"))
        choices.push(["volume", "Control audio with a volume slider"]);
      if (filters.length && available("SetSourceFilterEnabled"))
        choices.push(
          ["filter-toggle", "Enable / disable a filter"],
          ["filter-enable", "Enable a filter"],
          ["filter-disable", "Disable a filter"],
        );
      help.textContent = audioAvailable
        ? "Choose what this button should do to the selected source. Audio controls affect OBS only."
        : "Choose what this button should do. This object has no available OBS audio controls." +
          (!filters.length ? " No filters are currently configured on it." : "");
    }
    options(action, choices, "Choose an action…");
    emit(null);
    action.onchange = () =>
      void work(async () => {
        detail.replaceChildren();
        emit(null);
        if (!action.value) return;
        const kind = action.value;
        if (kind.startsWith("source-")) {
          const container = select("OBS visibility scene or group"),
            instance = select("OBS source instance");
          const containers = [
            ...state.scenes.map((r) => ({ name: r.sceneName, group: false })),
            ...(state.groups || []).map((name) => ({ name, group: true })),
          ];
          options(
            container,
            containers.map((r, i) => [String(i), (r.group ? "Group: " : "Scene: ") + r.name]),
          );
          container.add(new Option("All scenes and groups", "all"), 0);
          const active = containers.findIndex((r) => !r.group && r.name === state.program);
          if (active >= 0) container.value = String(active);
          const note = el("p", "", "deckEditorHint");
          detail.append(
            field("3. In which scene or group?", container),
            field("Source instance", instance),
            note,
          );
          let rows = [];
          const update = () => {
            if (container.value === "all") {
              emit(
                { kind, sourceName: selected.name, scope: "all" },
                "All scenes · " + selected.name,
              );
              return;
            }
            const row = rows[Number(instance.value)],
              parent = containers[Number(container.value)];
            emit(
              row && parent
                ? {
                    kind,
                    sourceName: selected.name,
                    sceneName: parent.name,
                    group: parent.group,
                    sceneItemId: row.sceneItemId,
                  }
                : null,
              (kind === "source-show"
                ? "Show: "
                : kind === "source-hide"
                  ? "Hide: "
                  : "Visibility: ") + selected.name,
            );
          };
          const load = async () => {
            emit(null);
            if (container.value === "all") {
              instance.closest("label").hidden = true;
              note.textContent =
                "Applies to every matching instance, including inside groups. Toggle shows all if any are hidden; otherwise it hides all. Filters and audio already apply to a source across scenes.";
              update();
              return;
            }
            const parent = containers[Number(container.value)];
            if (!parent) return;
            const result = await request(
              "/api/control-deck/obs/browse?kind=scene&name=" +
                encodeURIComponent(parent.name) +
                "&group=" +
                parent.group,
            );
            if (epoch !== generation) return;
            rows = result.items.filter((r) => r.sourceName === selected.name);
            options(
              instance,
              rows.map((r, i) => [
                String(i),
                selected.name + (rows.length > 1 ? " · instance " + (i + 1) : ""),
              ]),
            );
            instance.closest("label").hidden = rows.length < 2;
            note.textContent = rows.length
              ? "Controls this exact source instance. Hiding a camera does not turn off its device or microphone."
              : "This source is not in the selected scene/group. Choose another location.";
            update();
          };
          container.onchange = () => void work(load);
          instance.onchange = update;
          await load();
        } else if (kind.startsWith("filter-")) {
          const filter = select("OBS source filter");
          options(
            filter,
            filters.map((r) => [r.filterName, r.filterName]),
            "Choose a filter…",
          );
          detail.append(field("3. Which filter on " + selected.name + "?", filter));
          const update = () =>
            emit(
              filter.value ? { kind, sourceName: selected.name, filterName: filter.value } : null,
              (kind === "filter-enable"
                ? "Enable: "
                : kind === "filter-disable"
                  ? "Disable: "
                  : "Filter: ") +
                selected.name +
                " · " +
                filter.value,
            );
          filter.onchange = update;
          update();
        } else if (kind === "transition-choice") {
          const transition = select("OBS transition"),
            duration = el("input");
          options(
            transition,
            state.transitions.map((r) => [r.transitionName, r.transitionName]),
          );
          duration.type = "number";
          duration.min = 50;
          duration.max = 20000;
          duration.value = 300;
          detail.append(
            field("3. Which transition?", transition),
            field("Duration in milliseconds (where supported)", duration),
          );
          const update = () =>
            emit(
              transition.value
                ? { kind, transitionName: transition.value, duration: Number(duration.value) }
                : null,
              "Transition: " + transition.value,
            );
          transition.onchange = update;
          duration.oninput = update;
          update();
        } else {
          const target = { kind };
          if (["scene", "preview"].includes(kind)) target.sceneName = selected.name;
          else if (selected.type !== "obs") target.sourceName = selected.name;
          const actionLabel = choices.find((r) => r[0] === kind)?.[1] || kind;
          emit(target, selected.type === "obs" ? actionLabel : actionLabel + ": " + selected.name);
          if (kind === "volume")
            detail.append(el("p", "Volume spans 0–100% (0 dB at 100%).", "deckEditorHint"));
        }
      });
  }
  return {
    cancel() {
      generation++;
    },
    async build(next) {
      generation++;
      state = next;
      current = null;
      host.replaceChildren();
      const when = el("p", "When this button is pressed", "deckObsWhen");
      object = select("OBS object");
      action = select("OBS action");
      detail = el("div", undefined, "deckObsFields");
      help = el("p", "", "deckEditorHint");
      const objectField = field("1. Choose a source, scene or OBS itself", object),
        actionField = field("2. Choose what happens", action);
      options(object, [], "Choose an object…");
      for (const [type, label] of [
        ["source", "Sources"],
        ["scene", "Scenes"],
        ["group", "Groups"],
      ]) {
        const group = el("optgroup");
        group.label = label;
        for (const row of sources().filter((r) => r.type === type))
          group.append(new Option(row.name, row.type + ":" + row.name));
        if (group.childElementCount) object.append(group);
      }
      object.add(new Option("OBS Studio / outputs", "obs"));
      options(action, [], "Choose an object first");
      host.append(when, objectField, actionField, detail, help);
      if (!state.connection.connected || state.connection.loading)
        help.textContent = "Connect OBS to choose from its actual sources and scenes.";
      object.onchange = () => void work(chooseObject);
      emit(null);
    },
  };
}
