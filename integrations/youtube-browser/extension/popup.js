const api = globalThis.browser || globalThis.chrome;
const status = document.querySelector("#status");
document.querySelector("#pair").addEventListener("submit", async (event) => {
  event.preventDefault();
  const result = await api.runtime.sendMessage({
    type: "connect",
    port: Number(document.querySelector("#port").value),
    token: document.querySelector("#token").value.trim(),
  });
  status.textContent = result.error || "Connected. RaveLink shows playback and request status.";
  if (result.paired) document.querySelector("#token").value = "";
});
document.querySelector("#disconnect").addEventListener("click", async () => {
  await api.runtime.sendMessage({ type: "disconnect" });
  status.textContent = "Disconnected. Return to RaveLink Setup to connect another music tab.";
});
api.runtime.sendMessage({ type: "status" }).then((result) => {
  if (result.paired)
    status.textContent =
      "A music tab is connected. RaveLink shows playback and request status. Disconnect before selecting another tab.";
});
