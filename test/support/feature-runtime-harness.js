function createFeatureRuntimeHarness(feature, options = {}) {
  const providers = new Map(Object.entries(options.providers || {}));
  const calls = [];
  const events = [];
  let active = false;

  async function callCapability(capability, method, payload, callOptions = {}) {
    calls.push({ capability, method, payload, providerId: String(callOptions.providerId || "") });
    const provider = providers.get(`${capability}/${method}`);
    if (!provider) throw Object.assign(new Error("provider_unavailable"), { code: "provider_unavailable", retryable: true });
    return await provider(payload, callOptions);
  }

  function publishEvent(capability, event, payload) {
    events.push({ capability, event, payload });
    return true;
  }

  async function start() {
    if (active) return;
    await feature.activate(Object.freeze({ featureId: options.featureId || "song-request", callCapability, publishEvent }));
    active = true;
  }

  async function request(capability, method, payload, signal = new AbortController().signal) {
    if (!active) throw new Error("feature_not_active");
    return await feature.handleRequest({ capability, method, payload, signal, deadlineAt: Date.now() + 5000 });
  }

  async function stop() {
    if (!active) return;
    active = false;
    await feature.deactivate?.();
  }

  return Object.freeze({ calls, events, request, start, stop });
}

module.exports = { createFeatureRuntimeHarness };
