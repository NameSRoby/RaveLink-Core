// Standalone public mod API. This package must not import RaveLink server modules.

const HANDLERS = new Set(["activate", "deactivate", "handleRequest", "handleEvent"]);

function defineMod(implementation = {}) {
  if (!implementation || typeof implementation !== "object" || Array.isArray(implementation)) throw new TypeError("mod_definition_must_be_object");
  for (const [key, value] of Object.entries(implementation)) {
    if (!HANDLERS.has(key)) throw new TypeError(`unknown_mod_handler:${key}`);
    if (typeof value !== "function") throw new TypeError(`mod_handler_must_be_function:${key}`);
  }
  if (typeof implementation.activate !== "function") throw new TypeError("mod_activate_required");
  return Object.freeze({ ...implementation });
}

function createCapabilityClient(context) {
  if (!context || typeof context.callCapability !== "function" || typeof context.publishEvent !== "function") {
    throw new TypeError("ravelink_context_invalid");
  }
  return Object.freeze({
    call(capability, method, payload = null, options = {}) {
      return context.callCapability(String(capability), String(method), payload, options);
    },
    publish(capability, event, payload = null) {
      return context.publishEvent(String(capability), String(event), payload);
    }
  });
}

function summarizeManifest(manifest = {}) {
  const permissions = manifest.permissions || {};
  const resources = manifest.resources || {};
  return Object.freeze({
    id: String(manifest.id || ""),
    version: String(manifest.version || ""),
    consumes: Object.freeze([...(manifest.consumes || [])]),
    provides: Object.freeze([...(manifest.provides || [])]),
    permissions: Object.freeze({
      networkHosts: Object.freeze([...(permissions.network || [])]),
      storage: permissions.storage === true,
      secretHandles: Object.freeze([...(permissions.secrets || [])]),
      process: permissions.process === true,
      hardware: Object.freeze([...(permissions.hardware || [])]),
      ui: permissions.ui === true
    }),
    resources: Object.freeze({ ...resources })
  });
}

module.exports = { createCapabilityClient, defineMod, summarizeManifest };
