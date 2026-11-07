import { createObsBuilder } from "./control-deck-obs-builder.js";
/** User-built OBS buttons. Exploring, previewing and pinning never changes OBS. */
export function createObsPanel({ request, add, explain }) {
  const el = (tag, text, css) => {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (css) n.className = css;
    return n;
  };
  const button = (text, fn) => {
    const n = el("button", text);
    n.type = "button";
    n.onclick = () => void work(fn);
    return n;
  };
  const field = (label, control) => {
    const n = el("label", undefined, "deckField");
    n.append(el("span", label), control);
    return n;
  };
  const dialog = el("dialog", undefined, "deckEditor deckObsPanel"),
    heading = el("div", undefined, "deckEditorHeading"),
    notice = el("p", "", "deckEditorNotice"),
    status = el("p", "Not connected", "deckConnectionStatus");
  dialog.id = "deckObsPanel";
  dialog.setAttribute("aria-labelledby", "deckObsTitle");
  notice.setAttribute("role", "status");
  const title = el("h2", "OBS controls");
  title.id = "deckObsTitle";
  const close = button("Close", () => dialog.close());
  heading.append(title, close);
  const connection = el("section", undefined, "deckObsConnection"),
    summary = el("h3", "Connect OBS");
  const guide = el(
    "p",
    "OBS Studio 28+ includes everything needed. In OBS, open Tools → WebSocket Server Settings, enable the server, and press Apply. No extra plugin is needed.",
    "deckEditorHint",
  );
  const local = button("Connect this PC’s OBS", async () => {
    await request("/api/control-deck/obs/local", "POST", {});
    await read();
    await build();
  });
  local.className = "primary";
  const automatic = el(
    "p",
    "Use the OBS settings saved on this Windows PC. No host, port or password to copy.",
    "deckEditorHint",
  );
  const advanced = el("details"),
    advancedTitle = el("summary", "Connection details / another PC");
  const host = el("input"),
    port = el("input"),
    password = el("input");
  host.value = "127.0.0.1";
  host.maxLength = 64;
  port.type = "number";
  port.min = 1;
  port.max = 65535;
  port.value = 4455;
  password.type = "password";
  password.maxLength = 1024;
  password.autocomplete = "new-password";
  const connect = button("Save & connect", async () => {
    const body = { host: host.value.trim(), port: Number(port.value), enabled: true };
    if (password.value || !state?.connection.hasPassword) body.password = password.value;
    await request("/api/control-deck/obs/connection", "PUT", body);
    password.value = "";
    await read();
    await build();
  });
  const disconnect = button("Disconnect", async () => {
    await request("/api/control-deck/obs/disconnect", "POST", {});
    await read();
    await build();
  });
  const credentials = el(
    "p",
    "Your OBS password stays protected on the RaveLink PC. Phone and tablet buttons use Core’s connection.",
    "deckEditorHint",
  );
  advanced.append(
    advancedTitle,
    field("OBS host (local or private IPv4)", host),
    field("WebSocket port", port),
    field("Password (leave blank to keep saved password)", password),
    connect,
    disconnect,
    credentials,
  );
  connection.append(summary, guide, local, automatic, advanced);
  const builder = el("fieldset", undefined, "deckObsBuilder"),
    targetFields = el("div"),
    name = el("input"),
    imageOption = el("label", undefined, "deckCheck"),
    capture = el("input");
  name.maxLength = 80;
  name.setAttribute("aria-label", "Button label");
  capture.type = "checkbox";
  imageOption.append(capture, el("span", "Use a captured scene preview as the button image"));
  const preview = el("img"),
    previewNote = el("p", "", "deckEditorHint"),
    previewTools = el("div", undefined, "deckPanelActions");
  preview.alt = "Selected OBS scene preview";
  preview.hidden = true;
  preview.className = "deckObsPreview";
  const showPreview = button("Preview selected scene", () => loadPreview());
  previewTools.append(showPreview);
  const pin = button("Add button to this page", async () => {
    const target = selection;
    if (!target) throw Error("Choose a complete OBS control first.");
    const result = await request("/api/control-deck/obs/buttons", "POST", {
      target,
      previewImage: ["scene", "preview"].includes(target.kind) && capture.checked,
    });
    await add(
      name.value.trim() || result.label,
      result.id,
      result.action.defaults,
      result.action.symbol,
      target.kind === "volume" ? "slider" : "macro",
      result.imageId ? { imageId: result.imageId } : {},
    );
    notice.textContent = "Button added. Use Edit to change its image, light, label or position.";
  });
  builder.append(
    el("h3", "Create your own button"),
    targetFields,
    previewTools,
    preview,
    previewNote,
    field("Button label", name),
    imageOption,
    pin,
  );
  const refresh = button("Refresh OBS list", async () => {
    await read(true);
    await build();
  });
  dialog.append(heading, status, connection, refresh, notice, builder);
  document.body.append(dialog);
  let state = null,
    busy = false,
    selection = null,
    sceneSelected = "",
    autoName = "";
  function label(value) {
    const next = String(value).slice(0, 80);
    if (!name.value || name.value === autoName) name.value = next;
    autoName = next;
  }
  async function work(fn) {
    if (busy) return;
    busy = true;
    builder.disabled = true;
    notice.textContent = "";
    notice.dataset.error = "false";
    dialog.querySelectorAll("button,input,select").forEach((n) => (n.disabled = true));
    try {
      await fn();
    } catch (e) {
      notice.textContent = obsMessage(e, explain);
      notice.dataset.error = "true";
    } finally {
      busy = false;
      dialog.querySelectorAll("button,input,select").forEach((n) => (n.disabled = false));
      pin.disabled = !state?.connection.connected || state?.connection.loading || !selection;
      builder.disabled = !state?.connection.connected || state?.connection.loading;
      local.disabled = !state?.local?.serverEnabled;
      disconnect.disabled = !state?.connection.enabled;
    }
  }
  async function read(force = false) {
    const next = await request("/api/control-deck/obs" + (force ? "?refresh=true" : ""));
    state = next;
    status.textContent = next.connection.connected
      ? next.connection.loading
        ? "Connected · loading OBS controls…"
        : "Connected to OBS" + (next.collection ? " · " + next.collection : "")
      : obsMessage({ message: next.connection.code }, explain);
    summary.textContent = next.connection.connected ? "OBS connection · connected" : "Connect OBS";
    automatic.hidden = !next.local?.found;
    advanced.open = !next.local?.found && !next.connection.connected;
    host.value = next.connection.host;
    port.value = next.connection.port;
    local.hidden = !next.local?.found;
    local.disabled = !next.local?.serverEnabled;
    guide.textContent =
      next.local?.found && !next.local.serverEnabled
        ? "OBS is installed here. Enable its WebSocket server in Tools → WebSocket Server Settings → Enable WebSocket server → Apply, then press Refresh OBS list. RaveLink does not restart OBS."
        : "OBS Studio 28+ includes everything needed. Enable WebSocket Server Settings in OBS’s Tools menu, then connect. No extra plugin is needed.";
    pin.disabled = !next.connection.connected || next.connection.loading || !selection;
    return next;
  }
  async function loadPreview() {
    if (!sceneSelected) throw Error("Choose a scene first.");
    const value = await request(
      "/api/control-deck/obs/preview?scene=" + encodeURIComponent(sceneSelected),
    );
    preview.src = value.image;
    preview.hidden = false;
    previewNote.textContent =
      "Snapshot captured " +
      new Date().toLocaleTimeString() +
      ". Press Preview to refresh; scenes are never switched by previewing.";
  }
  const flow = createObsBuilder({
    host: targetFields,
    request,
    work,
    changed(target, defaultName, scene) {
      selection = target;
      label(defaultName);
      sceneSelected = scene;
      imageOption.hidden = !(target && ["scene", "preview"].includes(target.kind));
      previewTools.hidden = !scene;
      preview.hidden = true;
      previewNote.textContent = "";
      pin.disabled = !target || !state?.connection.connected;
    },
  });
  async function build() {
    await flow.build(state);
  }
  dialog.addEventListener("close", () => {
    flow.cancel();
    password.value = "";
    preview.removeAttribute("src");
    preview.hidden = true;
  });
  return {
    async open() {
      if (!dialog.open) dialog.showModal();
      notice.textContent = "";
      name.value = "";
      autoName = "";
      capture.checked = false;
      await work(async () => {
        await read();
        await build();
      });
    },
  };
}
function obsMessage(error, explain) {
  const code = error.code || error.message;
  return (
    {
      obs_not_connected: "OBS is not connected.",
      obs_connecting: "Connecting to OBS…",
      obs_connection_failed:
        "Cannot reach OBS. Enable its WebSocket server and check the host and port.",
      obs_authentication_failed: "OBS rejected the password. Check its WebSocket Server Settings.",
      obs_connection_timeout: "OBS did not answer. Check the server, port and local firewall.",
      obs_disconnected:
        "OBS disconnected. RaveLink will reconnect while the connection is enabled.",
      obs_enable_websocket_in_obs:
        "Enable the WebSocket server in OBS, press Apply, then refresh this list.",
      obs_scene_missing: "That scene is no longer available. Refresh the OBS list.",
    }[code] || explain(error)
  );
}
