// [TITLE] Module: capabilities/mod-platform/host/mod-builtin-services.js
// [TITLE] Purpose: compose optional permission services behind reserved broker contracts
// [TITLE] Functionality Index:
// [TITLE] - expose storage, network, and opaque secrets only through validated calls
// [TITLE] - resolve requester manifests inside the trusted host boundary
// [TITLE] - keep service registration independent from core composition

const createStorage = require("./mod-storage-service");
const createNetwork = require("./mod-network-service");
const createSecrets = require("./mod-secret-service");

const record = value => Boolean(value && typeof value === "object" && !Array.isArray(value));
const result = value => record(value) && typeof value.ok === "boolean";

module.exports = function createModBuiltinServices(options = {}) {
  const broker = options.broker;
  if (!broker) throw new Error("mod_service_broker_required");
  const getManifest = typeof options.getManifest === "function" ? options.getManifest : () => null;
  const storage = options.storage || createStorage({ dataRoot: options.dataRoot });
  const network = options.network || createNetwork({ transport: options.networkTransport, egressGovernor: options.egressGovernor });
  const secrets = options.secrets || createSecrets({ now: options.now });

  function manifestFor(context) {
    return getManifest(String(context?.requesterId || ""));
  }

  broker.registerContract({
    capability: "ravelink.storage.v1",
    methods: {
      get: { validateRequest: value => record(value) && typeof value.key === "string", validateResponse: result },
      set: { validateRequest: value => record(value) && typeof value.key === "string" && Object.hasOwn(value, "value"), validateResponse: result },
      remove: { validateRequest: value => record(value) && typeof value.key === "string", validateResponse: result },
      status: { validateRequest: value => value === null || record(value), validateResponse: result }
    }
  });
  broker.registerHostProvider({
    providerId: "ravelink.storage",
    capability: "ravelink.storage.v1",
    invoke: async (_capability, method, payload, context) => {
      const manifest = manifestFor(context);
      if (!manifest) return { ok: true, value: { ok: false, error: "requester_unknown" } };
      if (method === "get") return { ok: true, value: await storage.get(manifest, payload.key) };
      if (method === "set") return { ok: true, value: await storage.set(manifest, payload.key, payload.value) };
      if (method === "remove") return { ok: true, value: await storage.remove(manifest, payload.key) };
      return { ok: true, value: await storage.status(manifest) };
    }
  });

  broker.registerContract({
    capability: "ravelink.network.v1",
    methods: { request: { validateRequest: record, validateResponse: result } }
  });
  broker.registerHostProvider({
    providerId: "ravelink.network",
    capability: "ravelink.network.v1",
    invoke: async (_capability, _method, payload, context) => ({ ok: true, value: await network.request(manifestFor(context), payload, context) })
  });

  broker.registerContract({
    capability: "ravelink.secrets.v1",
    methods: { invoke: {
      validateRequest: value => record(value) && typeof value.handle === "string" && typeof value.operation === "string",
      validateResponse: result
    } }
  });
  broker.registerHostProvider({
    providerId: "ravelink.secrets",
    capability: "ravelink.secrets.v1",
    invoke: async (_capability, _method, payload, context) => ({
      ok: true,
      value: await secrets.invoke(manifestFor(context), payload.handle, payload.operation, payload.payload, context)
    })
  });

  return Object.freeze({ network, registerSecretHandle: secrets.register, secrets, storage });
};
