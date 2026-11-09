/** Serialized into the sandbox before authored panel code. No direct HTTP. */
module.exports = function installModUiClient() {
  const pending = new Map();
  let sequence = 0;
  const nonce = new URLSearchParams(location.hash.slice(1)).get("ravelinkRelay");
  window.addEventListener("message", (event) => {
    const value = event.data;
    if (event.source !== parent || value?.type !== "ravelink.mod.result" || value.nonce !== nonce)
      return;
    const call = pending.get(value.id);
    if (!call) return;
    pending.delete(value.id);
    clearTimeout(call.timer);
    if (value.result?.ok) call.resolve(value.result.value);
    else
      call.reject(Error(value.result?.error?.code || value.result?.error || "mod_ui_call_failed"));
  });
  window.ravelink = Object.freeze({
    call(capability, method, payload = null) {
      if (!nonce || pending.size >= 8) return Promise.reject(Error("mod_ui_busy"));
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Error("mod_ui_timeout"));
        }, 6000);
        pending.set(id, { resolve, reject, timer });
        parent.postMessage(
          { type: "ravelink.mod.call", nonce, id, capability, method, payload },
          "*",
        );
      });
    },
  });
};
