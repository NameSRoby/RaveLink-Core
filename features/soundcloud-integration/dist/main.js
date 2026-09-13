let context;

async function activate(nextContext) { context = nextContext; }

async function host(method, payload, timeoutMs = 5000) {
  if (!context) throw new Error("feature_not_active");
  return context.callCapability("soundcloud.catalog.host.v1", method, payload, { timeoutMs });
}

async function handleRequest(request) {
  const routes = {
    "soundcloud.connection.read.v1/status": ["status", 1500],
    "soundcloud.credentials.admin.v1/configure": ["configure", 2000],
    "soundcloud.credentials.admin.v1/clear": ["clear", 1500],
    "soundcloud.catalog.v1/status": ["status", 1500],
    "soundcloud.catalog.v1/resolve": ["resolve", 9000],
    "soundcloud.catalog.v1/import-playlist-start": ["import-playlist-start", 2000],
    "soundcloud.catalog.v1/import-playlist-status": ["import-playlist-status", 1500],
    "soundcloud.catalog.v1/import-playlist-page": ["import-playlist-page", 1500],
    "soundcloud.catalog.v1/import-playlist-cancel": ["import-playlist-cancel", 1500]
  };
  const route = routes[`${request.capability}/${request.method}`];
  if (!route) throw new Error("method_unavailable");
  return host(route[0], request.payload, route[1]);
}

async function deactivate() { context = null; }

module.exports = { activate, handleRequest, deactivate };
