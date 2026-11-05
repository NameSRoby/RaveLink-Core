/** Explicit LAN opt-in; the normal dashboard stays on loopback. */
(() => {
  const $ = (id) => document.getElementById(id);
  const dialog = $("networkSharing");
  async function load() {
    const response = await fetch("/api/network-sharing", { cache: "no-store" });
    const state = await response.json();
    if (!response.ok || !state.ok) throw Error("Could not read network sharing.");
    draw(state);
  }
  function draw(state) {
    $("lanEnabled").checked = state.enabled;
    $("lanPort").value = state.port;
    $("lanAddresses").replaceChildren();
    for (const url of state.urls) {
      const row = document.createElement("p"),
        link = document.createElement("a");
      link.href = url;
      link.textContent = url;
      link.target = "_blank";
      link.rel = "noopener";
      row.append(link);
      $("lanAddresses").append(row);
    }
    $("lanStatus").textContent = state.active
      ? state.urls.length
        ? "Sharing is on. Open one of these addresses on the same Wi-Fi or Ethernet network."
        : "Sharing is on, but no private IPv4 network address is available."
      : state.error
        ? "Sharing could not start: " + state.error + ". Choose another port or retry."
        : "Sharing is off. The desktop app and localhost are still available.";
  }
  $("networkShareButton").onclick = async () => {
    dialog.showModal();
    try {
      await load();
    } catch (error) {
      $("lanStatus").textContent = error.message;
    }
  };
  $("closeNetworkSharing").onclick = () => dialog.close();
  $("saveNetworkSharing").onclick = async () => {
    $("saveNetworkSharing").disabled = true;
    try {
      const response = await fetch("/api/network-sharing", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: $("lanEnabled").checked,
          port: Number($("lanPort").value),
        }),
      });
      const state = await response.json();
      if (!response.ok || !state.ok)
        throw Error(
          state.error === "EADDRINUSE" || state.error === "network_sharing_port_conflict"
            ? "That port is already in use. Choose another port."
            : "Network sharing could not be saved. " + (state.error || ""),
        );
      draw(state);
    } catch (error) {
      $("lanStatus").textContent = error.message;
    } finally {
      $("saveNetworkSharing").disabled = false;
    }
  };
})();
