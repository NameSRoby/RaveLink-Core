/** Pairing token arrives through a URL fragment, never an HTTP request or log.
 * Clear it from the address bar immediately; retain only in this tab's session.
 * All observed text is rendered as textContent, including hostile song metadata.
 */
const supplied = location.hash.slice(1);
if (/^[a-f0-9]{64}$/.test(supplied)) sessionStorage.setItem("pairing", supplied);
history.replaceState(null, "", location.pathname);
const token = sessionStorage.getItem("pairing") || "";
document.querySelector("#port").value = location.port;
document.querySelector("#code").value = token;
document.querySelector("#reveal").addEventListener("click", () => {
  const field = document.querySelector("#code");
  field.type = field.type === "password" ? "text" : "password";
  document.querySelector("#reveal").textContent =
    field.type === "password" ? "Show code" : "Hide code";
});
let state = null,
  busy = false;
async function request(route, body) {
  const response = await fetch(`/api/${route}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok)
    throw Error("Control unavailable or pairing rejected. Check connection and retry manually.");
  return response.json();
}
const buttons = [...document.querySelectorAll("[data-action]")];
function render() {
  const snapshot = state?.snapshot;
  const compatibility = snapshot?.native?.compatibility;
  const reasons = {
    queue_read_failed: "Queue inspection failed",
    queue_items_unavailable: "Queue is not available",
    queue_state_unavailable: "Queue state is not available",
    queue_dispatch_unavailable: "Queue control is not available",
    queue_state_mismatch: "Queue views disagree",
    queue_selection_unavailable: "Current queue selection is not verified",
    shuffle_not_supported: "Turn shuffle off for queue editing",
    queue_counter_unavailable: "Queue insertion counter is not recognized",
    queue_response_changed: "The queue service returned an unexpected response",
    queue_write_unconfirmed: "A queue edit had an uncertain outcome",
  };
  document.querySelector("#compatibility").textContent = !compatibility
    ? "Internal service checks unavailable; manual playback fallback may still work."
    : compatibility.blocked
      ? "Queue editing stopped: " +
        compatibility.reasons
          .map((reason) => reasons[reason])
          .filter(Boolean)
          .join("; ") +
        ". Inspect the queue before reloading YouTube Music. Reloading discards removal ownership; repeated failures need an adapter update."
      : compatibility.queueReady
        ? "Internal queue compatibility checks passed."
        : "Queue editing unavailable: " +
          compatibility.reasons
            .map((reason) => reasons[reason])
            .filter(Boolean)
            .join("; ") +
          ".";
  document.querySelector("#connection").textContent = !state
    ? "Console unavailable"
    : state.fresh
      ? "Connected · fresh observation"
      : state.connected
        ? "Connected · waiting for a fresh observation; controls paused"
        : "Disconnected · requests are not being delivered";
  document.querySelector("#song").textContent = snapshot?.current?.title || "No song observed";
  document.querySelector("#artist").textContent = snapshot?.current?.artist || "";
  document.querySelector("#time").textContent = snapshot?.current
    ? `${snapshot.paused ? "Paused" : "Playing"} · ${Math.floor(snapshot.position)} / ${Math.floor(snapshot.duration)} seconds${snapshot.ad ? " · Advertisement" : ""}`
    : "Start a song in YouTube Music to check playback controls.";
  buttons.forEach((button) => {
    button.disabled =
      busy ||
      !state?.fresh ||
      !snapshot?.controls ||
      snapshot.ad ||
      (button.dataset.action === "skip" && !snapshot.nextAvailable);
  });
  document.querySelector("#queue").replaceChildren(
    ...(snapshot?.queue || []).map((row) => {
      const li = document.createElement("li");
      li.textContent = `${row.title || row.videoId}${row.artist ? " — " + row.artist : ""}`;
      return li;
    }),
  );
}
buttons.forEach((button) =>
  button.addEventListener("click", async () => {
    busy = true;
    render();
    try {
      const result = await request("control", {
        id: crypto.randomUUID(),
        action: button.dataset.action,
        expectedVideoId: state?.snapshot?.current?.videoId,
        ...(button.dataset.action === "volume"
          ? { value: Number(document.querySelector("#volume").value) }
          : {}),
      });
      document.querySelector("#result").textContent = result.ok
        ? "Confirmed by the player."
        : result.error === "autoplay_blocked"
          ? "Firefox or your browser blocked automatic playback. Click Play in YouTube Music once, then retry Resume."
          : `Not confirmed: ${result.error}. Check the player before trying again.`;
    } catch (error) {
      document.querySelector("#result").textContent = error.message;
    } finally {
      busy = false;
      render();
    }
  }),
);
async function poll() {
  try {
    state = await request("status");
  } catch {
    state = null;
  }
  render();
  setTimeout(poll, 2000);
}
void poll();
