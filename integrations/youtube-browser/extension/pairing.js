/** Runs only on the bridge's local connect page. The token never enters YouTube.
 * Pairing requires a trusted click and an explicitly chosen music tab. */
(() => {
  if (
    window.top !== window ||
    location.hostname !== "127.0.0.1" ||
    location.pathname !== "/connect.html" ||
    document.querySelector('meta[name="ravelink-browser-pairing"]')?.content !== "v1"
  )
    return;
  const api = globalThis.browser || globalThis.chrome;
  const fragment = location.hash.slice(1);
  const port = Number(location.port);
  if (!/^[a-f0-9]{64}$/.test(fragment)) {
    document.getElementById("pairingStatus").textContent =
      "Return to RaveLink Setup and choose Connect YouTube Music again.";
    return;
  }
  history.replaceState(null, "", location.pathname);
  const status = document.getElementById("pairingStatus"),
    list = document.getElementById("pairingTabs"),
    button = document.getElementById("connectMusicTab");
  let selected = null;
  function findTabs() {
    selected = null;
    button.disabled = true;
    list.replaceChildren();
    return api.runtime
      .sendMessage({ type: "pairing-tabs", port, token: fragment })
      .then((result) => {
        if (result.error) {
          status.textContent = result.error;
          return;
        }
        const tabs = result.tabs || [];
        status.textContent = tabs.length
          ? "Select your YouTube Music tab, then connect."
          : "Open YouTube Music in this browser and play a song once, then choose Find music tabs below.";
        for (const tab of tabs) {
          const label = document.createElement("label"),
            radio = document.createElement("input"),
            name = document.createElement("span");
          radio.type = "radio";
          radio.name = "musicTab";
          radio.value = String(tab.id);
          name.textContent = tab.title || "YouTube Music";
          radio.onchange = () => {
            selected = tab.id;
            button.disabled = false;
          };
          if (tabs.length === 1) {
            radio.checked = true;
            selected = tab.id;
            button.disabled = false;
          }
          label.append(radio, name);
          list.append(label);
        }
      })
      .catch(() => {
        status.textContent =
          "The companion could not contact RaveLink. Return to Setup and connect again.";
      });
  }
  void findTabs();
  document.getElementById("refreshMusicTabs").onclick = (event) => {
    if (event.isTrusted) void findTabs();
  };
  button.onclick = async (event) => {
    if (!event.isTrusted || selected === null) return;
    button.disabled = true;
    try {
      const result = await api.runtime.sendMessage({
        type: "pairing-connect",
        port,
        token: fragment,
        tabId: selected,
      });
      status.textContent =
        result.error ||
        "Connected. Return to RaveLink to request songs. Playback stays in your music tab.";
      if (!result.paired) button.disabled = false;
      else document.getElementById("refreshMusicTabs").disabled = true;
    } catch {
      status.textContent = "Connection could not be confirmed. Return to RaveLink and try again.";
      button.disabled = false;
    }
  };
})();
