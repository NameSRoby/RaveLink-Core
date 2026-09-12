const { createCapabilityClient } = require("./index");

function createModTestHarness(mod, options = {}) {
  const providers = new Map(Object.entries(options.providers || {}));
  const calls = [];
  const events = [];
  let currentTime = Number(options.startAt || 1700000000000);
  let active = false;
  let activationContext = null;

  function now() { return currentTime; }
  function advance(ms) {
    const amount = Number(ms);
    if (!Number.isFinite(amount) || amount < 0) throw new TypeError("clock_advance_invalid");
    currentTime += amount;
    return currentTime;
  }

  async function callCapability(capability, method, payload, callOptions = {}) {
    const key = `${capability}/${method}`;
    calls.push({ at: now(), capability, method, payload, providerId: String(callOptions.providerId || "") });
    const provider = providers.get(key);
    if (!provider) throw Object.assign(new Error("provider_unavailable"), { code: "provider_unavailable", retryable: true });
    return await provider(payload, Object.freeze({ now, providerId: String(callOptions.providerId || "") }));
  }

  function publishEvent(capability, event, payload) {
    events.push({ at: now(), capability, event, payload });
    return true;
  }

  async function start() {
    if (active) return activationContext;
    activationContext = Object.freeze({
      modId: String(options.modId || "test.mod"),
      capabilities: Object.freeze([...(options.provides || [])]),
      consumedCapabilities: Object.freeze([...(options.consumes || [])]),
      callCapability,
      publishEvent,
      now
    });
    await mod.activate(activationContext);
    active = true;
    return activationContext;
  }

  async function request(capability, method, payload, signal = new AbortController().signal) {
    if (!active) throw new Error("mod_not_active");
    if (typeof mod.handleRequest !== "function") throw new Error("mod_request_handler_missing");
    return await mod.handleRequest({ capability, method, payload, signal, deadlineAt: now() + 5000 });
  }

  async function emit(capability, event, payload) {
    if (!active) throw new Error("mod_not_active");
    if (typeof mod.handleEvent === "function") return await mod.handleEvent({ capability, event, payload });
    return undefined;
  }

  async function stop() {
    if (!active) return;
    active = false;
    if (typeof mod.deactivate === "function") await mod.deactivate();
  }

  return Object.freeze({
    advance,
    calls,
    createClient: () => createCapabilityClient(activationContext),
    emit,
    events,
    now,
    request,
    start,
    stop
  });
}

module.exports = { createModTestHarness };
