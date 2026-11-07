/** Explicit LAN opt-in; the normal dashboard stays on loopback. */
(() => {
  const $ = (id) => document.getElementById(id);
  const dialog = $("networkSharing");
  const localPc = ["127.0.0.1", "localhost"].includes(location.hostname);
  $("lanFirewall").hidden = !localPc;
  if (!localPc)
    $("lanFirewallStatus").textContent = "Windows network access is set up from the RaveLink PC.";
  $("lanFirewall").onclick = async () => {
    $("lanFirewall").disabled = true;
    $("lanFirewallStatus").textContent =
      "Waiting for Windows approval. Access is limited to Private networks and your local subnet.";
    try {
      const response = await fetch("/api/network-sharing/firewall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const result = await response.json();
      if (!response.ok || !result.ok)
        throw Error("Windows setup was cancelled or could not finish. You can retry from this PC.");
      $("lanFirewallStatus").textContent =
        "Windows network access is configured for this installation. Private networks and local subnet only. Keep the same installation folder when updating.";
    } catch (error) {
      $("lanFirewallStatus").textContent = error.message;
    } finally {
      $("lanFirewall").disabled = false;
    }
  };
  let urls = [],
    revealed = false;
  function showAddress() {
    $("lanPrivate").hidden = !revealed;
    $("lanReveal").setAttribute("aria-expanded", String(revealed));
    $("lanReveal").textContent = revealed ? "Hide link & QR code" : "Show link & QR code";
    if (!revealed) {
      $("lanLink").removeAttribute("href");
      $("lanLink").textContent = "";
      $("lanQr").removeAttribute("src");
      return;
    }
    const url = $("lanNetwork").value;
    if (!urls.includes(url)) return;
    $("lanLink").href = url;
    $("lanLink").textContent = url;
    $("lanCopy").textContent = "Copy link";
    $("lanQrStatus").textContent = "";
    $("lanQr").hidden = false;
    $("lanQr").src = "/api/network-sharing/qr.svg?url=" + encodeURIComponent(url);
  }
  $("lanReveal").onclick = () => {
    revealed = !revealed;
    showAddress();
  };
  dialog.addEventListener("close", () => {
    revealed = false;
    showAddress();
  });
  $("lanNetwork").onchange = showAddress;
  $("lanQr").onerror = () => {
    $("lanQr").hidden = true;
    $("lanQrStatus").textContent = "QR code unavailable. You can still copy or open the link.";
  };
  $("lanCopy").onclick = async () => {
    const url = $("lanNetwork").value;
    if (!urls.includes(url)) return;
    try {
      await navigator.clipboard.writeText(url);
      $("lanCopy").textContent = "Copied";
    } catch {
      const range = document.createRange();
      range.selectNodeContents($("lanLink"));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      $("lanQrStatus").textContent = "Link selected. Copy it with your device's copy command.";
    }
  };
  async function load() {
    const response = await fetch("/api/network-sharing", { cache: "no-store" });
    const state = await response.json();
    if (!response.ok || !state.ok) throw Error("Could not read network sharing.");
    draw(state);
  }
  function draw(state) {
    $("lanEnabled").checked = state.enabled;
    $("lanPort").value = state.port;
    const previous = $("lanNetwork").value;
    urls = state.active ? state.urls : [];
    $("lanAddresses").hidden = !urls.length;
    $("lanNetwork").replaceChildren(...urls.map((url) => new Option(url, url)));
    $("lanNetworkLabel").hidden = urls.length < 2;
    if (urls.includes(previous)) $("lanNetwork").value = previous;
    if (urls.length) showAddress();
    else $("lanQr").removeAttribute("src");
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
