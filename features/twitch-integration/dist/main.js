let context;

async function activate(nextContext) { context = nextContext; }

async function host(method, payload, timeoutMs = 5000) {
  if (!context) throw new Error("feature_not_active");
  return context.callCapability("twitch.host.v1", method, payload, { timeoutMs });
}

async function handleRequest(request) {
  const routes = {
    "twitch.connection.read.v1/status": ["status", 1500],
    "twitch.oauth.admin.v1/configure": ["configure", 1500],
    "twitch.monitor.admin.v1/configure": ["configure-monitor", 1500],
    "twitch.oauth.admin.v1/clear": ["clear-client-id", 1500],
    "twitch.oauth.admin.v1/begin": ["begin", 6000],
    "twitch.oauth.admin.v1/poll": ["poll", 6000],
    "twitch.oauth.admin.v1/disconnect": ["disconnect", 1500],
    "twitch.rewards.read.v1/inspect": ["inspect-reward", 6000],
    "twitch.rewards.admin.v1/create": ["create-reward", 6000],
    "twitch.redemptions.v1/settle": ["settle", 6000],
    "twitch.chat.send.v1/send": ["send-chat", 6000]
  };
  const route = routes[`${request.capability}/${request.method}`];
  if (!route) throw new Error("method_unavailable");
  return host(route[0], request.payload, route[1]);
}

async function deactivate() { context = null; }

module.exports = { activate, handleRequest, deactivate };
