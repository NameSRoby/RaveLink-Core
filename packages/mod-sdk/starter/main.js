/** Permission-free example: the button controls this mod's own in-memory state. */
let enabled = false;
const status = () => ({
  ok: true,
  enabled,
  feedback: {
    state: enabled ? "active" : "inactive",
    label: enabled ? "Enabled" : "Disabled",
    active: enabled,
    color: enabled ? "#21a97d" : "#607085",
  },
});
module.exports = {
  activate() {
    enabled = false;
  },
  handleRequest({ capability, method, signal }) {
    if (signal?.aborted) throw Error("request_cancelled");
    if (capability !== "example.button.v1") throw Error("capability_unavailable");
    if (method === "toggle") enabled = !enabled;
    else if (method !== "status") throw Error("method_unavailable");
    return status();
  },
  deactivate() {
    enabled = false;
  },
};
