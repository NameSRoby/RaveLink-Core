/** Example of a broker-only action mod. Twitch access stays in the Core owner. */
let context = null;
module.exports = {
  activate(value) {
    context = value;
  },
  deactivate() {
    context = null;
  },
  handleRequest(request) {
    if (
      !context ||
      request.capability !== "stream.clip.v1" ||
      !["create", "status"].includes(request.method)
    )
      throw Error("clip_action_unavailable");
    return context.callCapability("twitch.clips.host.v1", request.method, request.payload || {}, {
      timeoutMs: 10000,
    });
  },
};
