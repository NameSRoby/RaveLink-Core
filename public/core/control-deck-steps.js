/** Build ordinary form controls from the host's declared action parameters.
 * Complex data stays explicit JSON; none of these fields is executable code.
 */
const clone = (value) => structuredClone(value);
const node = (tag, className, text) => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
};
function parameterForm(host, schema = {}, initial = {}, sendKey) {
  const fields = [],
    value = clone(initial || {}),
    properties = schema.properties || {};
  const simple = Object.entries(properties).filter(
    ([, f]) => ["string", "number", "integer", "boolean"].includes(f.type) && !f.oneOf && !f.anyOf,
  );
  const complex =
    Object.keys(value).some((key) => !properties[key]) ||
    Object.keys(properties).length !== simple.length;
  if (complex || (!Object.keys(properties).length && Object.keys(value).length)) {
    const label = node("label", "deckField"),
      input = node("textarea");
    input.rows = 4;
    input.value = JSON.stringify(value, null, 2);
    label.append(node("span", "", "Action data (JSON)"), input);
    host.append(label);
    return () => {
      let parsed;
      try {
        parsed = JSON.parse(input.value);
      } catch {
        throw Error("Check the action data JSON.");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw Error("Action data must be a JSON object.");
      return parsed;
    };
  }
  for (const [key, property] of simple) {
    const label = node("label", "deckField"),
      control = node(property.enum ? "select" : "input");
    const required = schema.required?.includes(key);
    if (property.enum) {
      if (!required) control.add(new Option("Default", ""));
      for (const option of property.enum) control.add(new Option(String(option), String(option)));
    } else
      control.type =
        property.type === "boolean"
          ? "checkbox"
          : ["number", "integer"].includes(property.type)
            ? "number"
            : "text";
    const current = value[key] ?? property.default;
    if (property.type === "boolean") control.checked = current === true;
    else control.value = current === undefined ? "" : current;
    if (property.minimum !== undefined) control.min = property.minimum;
    if (property.maximum !== undefined) control.max = property.maximum;
    if (property.maxLength) control.maxLength = property.maxLength;
    if (property.type === "integer") control.step = 1;
    control.required = required && property.type !== "boolean";
    control.dataset.deckParameter = key;
    label.append(
      node("span", "", (property.title || key.replace(/([A-Z])/g, " $1")) + (required ? " *" : "")),
      control,
    );
    if (property.description) {
      const help = node("small", "", property.description);
      label.append(help);
    }
    host.append(label);
    if (key === "shortcut" && sendKey) {
      host.classList.add("deckHotkeyParameters");
      const picker = node("select"),
        tools = node("div", "deckHotkeyTools"),
        send = node("button", "", "Send key in 5 seconds"),
        status = node("small", "deckEditorHint");
      picker.setAttribute("aria-label", "Rare keyboard key");
      picker.add(new Option("Choose a rarely used key…", ""));
      for (let n = 13; n <= 24; n++) {
        for (const prefix of ["", "Ctrl+Shift+"])
          picker.add(new Option(prefix + "F" + n, prefix + "F" + n));
      }
      picker.onchange = () => {
        if (picker.value) control.value = picker.value;
      };
      send.type = "button";
      send.onclick = async () => {
        if (!control.value.trim() || !control.reportValidity()) return;
        const shortcut = control.value.trim();
        send.disabled = true;
        try {
          for (let remaining = 5; remaining > 0; remaining--) {
            status.textContent = `Sending ${shortcut} in ${remaining}s. Focus the app that should receive it.`;
            await new Promise((resolve) => setTimeout(resolve, 1000));
            if (!send.isConnected || !send.closest("dialog")?.open) return;
          }
          await sendKey(shortcut);
          status.textContent = "Key sent on the RaveLink PC.";
        } catch (error) {
          status.textContent =
            {
              desktop_input_blocked:
                "Windows blocked the key input. Run RaveLink and the receiving app at the same permission level, then retry.",
              desktop_keys_busy: "Release Ctrl, Shift, Alt and Windows keys, then retry.",
              desktop_action_timeout: "Windows did not respond in time. Retry the key send.",
            }[error.message] || "The key could not be sent. Check the receiving app and retry.";
        } finally {
          send.disabled = false;
        }
      };
      tools.append(picker, send, status);
      host.append(
        tools,
        node(
          "p",
          "deckEditorHint",
          "F13–F24 are valid Windows keys absent from most keyboards. Buttons send input on the RaveLink PC, including from your phone or tablet.",
        ),
      );
    }
    fields.push({ key, property, control, required });
  }
  return () => {
    const result = {};
    for (const { key, property, control, required } of fields) {
      if (!control.reportValidity()) throw Error("Complete the required action fields.");
      if (property.type === "boolean") result[key] = control.checked;
      else if (control.value !== "")
        result[key] = ["number", "integer"].includes(property.type)
          ? Number(control.value)
          : control.value;
      else if (required) throw Error("Complete " + key + ".");
    }
    return result;
  };
}
export function buildActionSteps(host, title, initial, catalog, sendKey) {
  let steps = clone(initial),
    readers = [];
  const heading = node("h3", "", title),
    list = node("div", "deckStepList"),
    notice = node("p", "deckStepNotice"),
    add = node("button", "", "+ Add action");
  add.type = "button";
  notice.setAttribute("role", "status");
  host.append(heading, list, add, notice);
  function read() {
    return readers.map((get) => get());
  }
  function capture() {
    try {
      steps = read();
      notice.textContent = "";
      return true;
    } catch (error) {
      notice.textContent = error.message;
      return false;
    }
  }
  function draw() {
    readers = [];
    list.replaceChildren();
    steps.forEach((step, index) => {
      const card = node("div", "deckStep"),
        row = node("div", "deckStepHeading"),
        choice = node("select");
      choice.setAttribute("aria-label", `${title}, action ${index + 1}`);
      const groups = new Map();
      for (const action of catalog) {
        if (!groups.has(action.group)) {
          const group = node("optgroup");
          group.label = action.group;
          groups.set(action.group, group);
          choice.append(group);
        }
        groups
          .get(action.group)
          .append(
            new Option(
              action.label + (action.available === false ? " · unavailable" : ""),
              action.id,
            ),
          );
      }
      if (!catalog.some((action) => action.id === step.actionId))
        choice.add(
          new Option("Unavailable action: " + (step.actionId || "choose one"), step.actionId || ""),
        );
      choice.value = step.actionId;
      const action = catalog.find((a) => a.id === step.actionId),
        params = node("div", "deckStepParameters");
      const parameters = parameterForm(
        params,
        action?.parameters || {},
        step.params,
        action?.id === "native.hotkey" ? sendKey : undefined,
      );
      const delay = node("input");
      delay.type = "number";
      delay.min = 0;
      delay.max = 10000;
      delay.step = 50;
      delay.value = step.delayMs || 0;
      delay.setAttribute("aria-label", "Wait before this action, milliseconds");
      const delayLabel = node("label", "deckField");
      delayLabel.append(node("span", "", "Wait before action (ms)"), delay);
      row.append(node("span", "deckStepNumber", String(index + 1)), choice);
      for (const [label, symbol, delta] of [
        ["Move action up", "↑", -1],
        ["Move action down", "↓", 1],
        ["Remove action", "×", 0],
      ]) {
        const control = node("button", "deckSmallButton", symbol);
        control.type = "button";
        control.setAttribute("aria-label", label);
        control.title = label;
        control.disabled = (delta < 0 && index === 0) || (delta > 0 && index === steps.length - 1);
        control.onclick = () => {
          if (!capture()) return;
          if (delta) [steps[index], steps[index + delta]] = [steps[index + delta], steps[index]];
          else steps.splice(index, 1);
          draw();
        };
        row.append(control);
      }
      card.append(row);
      if (action?.description) card.append(node("p", "deckEditorHint", action.description));
      card.append(params, delayLabel);
      list.append(card);
      readers.push(() => {
        if (!choice.value) throw Error("Choose an action.");
        if (!delay.reportValidity()) throw Error("Delay must be between 0 and 10,000 ms.");
        return { actionId: choice.value, params: parameters(), delayMs: Number(delay.value || 0) };
      });
      choice.onchange = () => {
        try {
          steps = readers.map((get, i) => (i === index ? steps[i] : get()));
        } catch (error) {
          notice.textContent = error.message;
          return;
        }
        const selected = catalog.find((a) => a.id === choice.value);
        steps[index] = {
          actionId: choice.value,
          params: clone(selected?.defaults || {}),
          delayMs: Number(delay.value || 0),
        };
        draw();
      };
    });
    add.disabled = steps.length >= 16;
  }
  add.onclick = () => {
    if (!capture()) return;
    const action = catalog.find((a) => a.available) || catalog[0];
    if (!action) {
      notice.textContent = "No actions are available. Enable a package or mod first.";
      return;
    }
    steps.push({ actionId: action.id, params: clone(action.defaults || {}), delayMs: 0 });
    draw();
  };
  draw();
  return {
    read,
    replace(value) {
      steps = clone(value);
      draw();
    },
  };
}
